#!/usr/bin/env python3
"""
SmartBusOpt TraCI live-streaming bridge (build prompt §5.6, §2.3).

Runs ONE SUMO scenario (current OR alternative) headless via TraCI and streams
newline-delimited JSON to stdout. Every vehicle position is read from the live
SUMO/TraCI state and converted from network x/y to lon/lat with the network's own
geo-projection — never faked, never treated as lat/lon directly (§11).

The Node backend spawns this per scenario, forwards the JSON lines over SSE, and
orchestrates the overall progress stepper.

Message types emitted on stdout (one JSON object per line):
  {"type":"stage","stage":"..."}                progress stage for the stepper
  {"type":"frame","simulationTime":t,"vehicles":[...],"buses":[...],"metrics":{...}}
  {"type":"done","label":"current","measured":{...}}   final aggregated metrics
  {"type":"error","message":"..."}              fatal problem (never a fake result)

Run with the SYSTEM python (Homebrew py3.14 has a broken XML parser) and
PYTHONPATH=$SUMO_HOME/tools. TraCI (not libsumo) is used because the libsumo
python binding is not shipped in this SUMO package.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

try:
    import traci
    import traci.constants as tc
except ImportError:
    sys.stderr.write("ERROR: traci not importable. Set PYTHONPATH=$SUMO_HOME/tools "
                     "and use /usr/bin/python3.\n")
    raise


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def resolve_sumo_bin(explicit=None):
    if explicit:
        return explicit
    env = os.environ.get("SUMO_BIN")
    if env:
        return env
    home = os.environ.get("SUMO_HOME")
    cands = []
    if home:
        cands.append(os.path.join(os.path.dirname(home), "bin", "sumo"))
        cands.append(os.path.join(home, "bin", "sumo"))
    cands.append(os.path.expanduser("~/Applications/Sumo/bin/sumo"))
    cands.append("/Applications/Sumo/bin/sumo")
    for c in cands:
        if os.path.exists(c):
            return c
    # last resort: hope it's on PATH
    return "sumo"


def parse_tripinfo(path, bus_type="bus"):
    """Aggregate REAL measured metrics from SUMO's tripinfo output. Every number here
    is a SUMO measurement, not a prediction."""
    agg = {
        "completed": 0,
        "busCompleted": 0,
        "sumDuration": 0.0, "sumTimeLoss": 0.0, "sumWaiting": 0.0, "sumRouteLen": 0.0,
        "busSumDuration": 0.0, "busSumTimeLoss": 0.0, "busSumWaiting": 0.0,
        "busSumRouteLen": 0.0,
    }
    if not os.path.exists(path):
        return None
    speeds = []
    bus_speeds = []
    with open(path, "rb") as f:
        for _, veh in ET.iterparse(f, events=("end",)):
            if veh.tag != "tripinfo":
                continue
        try:
            dur = float(veh.get("duration", "0"))       # seconds
            tl = float(veh.get("timeLoss", "0"))          # seconds
            wait = float(veh.get("waitingTime", "0"))     # seconds
            stop_t = float(veh.get("stopTime", "0"))      # seconds
            rl = float(veh.get("routeLength", "0"))       # meters
            vtype = veh.get("vType", "")
        except (TypeError, ValueError):
            veh.clear()
            continue
        agg["completed"] += 1
        agg["sumDuration"] += dur
        agg["sumTimeLoss"] += tl
        agg["sumWaiting"] += wait
        agg["sumRouteLen"] += rl
        if rl > 0 and dur > 0:
            speeds.append(rl / dur)
        is_bus = (vtype == bus_type)
        if is_bus:
            agg["busCompleted"] += 1
            agg["busSumDuration"] += dur
            agg["busSumTimeLoss"] += tl
            agg["busSumWaiting"] += wait + stop_t
            agg["busSumRouteLen"] += rl
            if rl > 0 and dur > 0:
                bus_speeds.append(rl / dur)
        veh.clear()

    def mean(xs):
        return round(sum(xs) / len(xs), 3) if xs else None

    n = agg["completed"] or 1
    bn = agg["busCompleted"] or 1
    return {
        "provenance": "SUMO-measured",
        "vehiclesCompleted": agg["completed"],
        "avgTravelTimeSec": round(agg["sumDuration"] / n, 2),
        "avgDelaySec": round(agg["sumTimeLoss"] / n, 2),
        "avgWaitingSec": round(agg["sumWaiting"] / n, 2),
        "avgSpeedMs": mean(speeds),
        "avgRouteLengthM": round(agg["sumRouteLen"] / n, 1),
        "bus": {
            "completed": agg["busCompleted"],
            "avgTravelTimeSec": round(agg["busSumDuration"] / bn, 2) if agg["busCompleted"] else None,
            "avgDelaySec": round(agg["busSumTimeLoss"] / bn, 2) if agg["busCompleted"] else None,
            "avgStopWaitingSec": round(agg["busSumWaiting"] / bn, 2) if agg["busCompleted"] else None,
            "avgSpeedMs": mean(bus_speeds),
        },
    }


def run_scenario(cfg, label, sumo_bin, emit_every, fps, duration_limit, recommended_stop):
    trip_fd, trip_path = tempfile.mkstemp(suffix=".tripinfo.xml")
    os.close(trip_fd)
    cmd = [
        sumo_bin, "-c", cfg,
        "--no-step-log", "true",
        "--tripinfo-output", trip_path,
        "--collision.action", "warn",
        "--no-warnings", "true",
    ]
    if duration_limit:
        cmd += ["--end", str(duration_limit)]

    emit({"type": "stage", "stage": "Starting SUMO", "label": label})
    try:
        # traci prints connection-retry noise to stdout while SUMO loads the (large)
        # network; keep our JSON stdout stream clean by diverting it to stderr.
        import contextlib
        with contextlib.redirect_stdout(sys.stderr):
            traci.start(cmd, label=f"smartbusopt-{label}", numRetries=30)
    except Exception as e:
        emit({"type": "error", "label": label,
              "message": f"could not start SUMO: {e}", "sumoBin": sumo_bin})
        return 2

    emit({"type": "stage", "stage": "Running simulation", "label": label})
    traci.simulation.subscribe([tc.VAR_LOADED_VEHICLES_NUMBER, tc.VAR_DEPARTED_VEHICLES_NUMBER])
    step_len_guess = traci.simulation.getDeltaT() or 1.0

    step = 0
    max_queue = 0
    sum_speed = 0.0
    speed_samples = 0
    # frames are emitted every `emit_every` SIMULATED seconds; step_len is the sim step (s)
    frame_interval = max(1, int(round(emit_every / step_len_guess)))
    pace = (1.0 / fps) if fps and fps > 0 else 0.0
    step_len = step_len_guess
    next_frame_wall = time.time()

    def collect():
        """Read the LIVE vehicle state from TraCI and convert x/y -> lon/lat with the
        network's own geo-projection. Returns (vehicles, buses, halting, inst_speed_sum).
        Every value here is real SUMO/TraCI state — never fabricated (§11)."""
        ids = traci.vehicle.getIDList()
        halting = 0
        spd_sum = 0.0
        vehicles = []
        buses = []
        for vid in ids:
            try:
                x, y = traci.vehicle.getPosition(vid)
                sp = traci.vehicle.getSpeed(vid)
                lane = traci.vehicle.getLaneID(vid)
                edge = traci.vehicle.getRoadID(vid)
                vtype = traci.vehicle.getTypeID(vid)
            except Exception:
                continue
            if sp < 0.1:
                halting += 1
            spd_sum += sp
            lon, lat = traci.simulation.convertGeo(x, y, False)
            rec = {
                "id": vid, "type": vtype,
                "lon": round(lon, 6), "lat": round(lat, 6),
                "speed": round(sp, 2), "edgeId": edge, "laneId": lane,
            }
            if vtype == "bus":
                rec["isBus"] = True
                try:
                    nxt = traci.vehicle.getNextStops(vid)
                    rec["nextStop"] = nxt[0][0] if nxt else None
                except Exception:
                    pass
                buses.append(rec)
            else:
                vehicles.append(rec)
        return vehicles, buses, halting, spd_sum, len(ids)

    try:
        while traci.simulation.getMinExpectedNumber() > 0:
            traci.simulationStep()
            step += 1
            sim_time = traci.simulation.getTime()

            # TraCI ignores the config <end>, so enforce the duration limit here.
            if duration_limit and sim_time >= duration_limit:
                break

            is_frame_step = (step % frame_interval == 0)
            if is_frame_step:
                vehicles, buses, halting, spd_sum, n_ids = collect()
                sum_speed += spd_sum
                speed_samples += n_ids
                max_queue = max(max_queue, halting)
                live_metrics = {
                    "activeVehicles": n_ids,
                    "haltingVehicles": halting,
                    "buses": len(buses),
                    "avgSpeedMs": round(sum_speed / speed_samples, 2) if speed_samples else None,
                    "maxQueueLength": max_queue,
                }
                emit({
                    "type": "frame",
                    "label": label,
                    "simulationTime": round(sim_time, 1),
                    "vehicles": vehicles,
                    "buses": buses,
                    "metrics": live_metrics,
                })
                # pace the FRAME stream to ~fps wall-clock so the map visibly animates
                # without waiting on real-time simulation (which would take 25 min).
                if pace > 0:
                    next_frame_wall += pace
                    slack = next_frame_wall - time.time()
                    if slack > 0:
                        time.sleep(slack)
                    else:
                        # fell behind; reset the schedule so we don't burst to catch up
                        next_frame_wall = time.time()
    except Exception as e:
        emit({"type": "error", "label": label, "message": f"simulation crashed: {e}"})
        try:
            traci.close()
        except Exception:
            pass
        return 3
    finally:
        try:
            traci.close()
        except Exception:
            pass

    measured = parse_tripinfo(trip_path)
    if measured:
        measured["maxQueueLength"] = max_queue
    try:
        os.remove(trip_path)
    except OSError:
        pass

    emit({"type": "stage", "stage": "Collecting metrics", "label": label})
    emit({
        "type": "done",
        "label": label,
        "recommendedStop": recommended_stop,
        "simTimeSec": round(step * step_len, 1),
        "steps": step,
        "measured": measured,
    })
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True, help="path to scenario.sumocfg")
    ap.add_argument("--label", default="current")
    ap.add_argument("--sumo-bin", default=None)
    ap.add_argument("--emit-every", type=float, default=2.0,
                    help="emit a frame every N simulated seconds")
    ap.add_argument("--fps", type=float, default=20.0,
                    help="wall-clock frames/sec pacing (0 = as fast as possible)")
    ap.add_argument("--duration", type=float, default=0.0,
                    help="override simulation end time (0 = use scenario config)")
    ap.add_argument("--recommended-stop", default=None)
    args = ap.parse_args()

    if not os.path.exists(args.config):
        emit({"type": "error", "label": args.label,
              "message": f"scenario config not found: {args.config}"})
        sys.exit(2)

    sumo_bin = resolve_sumo_bin(args.sumo_bin)
    rc = run_scenario(
        args.config, args.label, sumo_bin,
        emit_every=args.emit_every, fps=args.fps,
        duration_limit=args.duration or None,
        recommended_stop=args.recommended_stop,
    )
    sys.exit(rc)


if __name__ == "__main__":
    main()
