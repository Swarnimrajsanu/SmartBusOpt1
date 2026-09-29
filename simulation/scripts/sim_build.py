#!/usr/bin/env python3
"""
SmartBusOpt scenario builder (build prompt §5.4-§5.5, §7 candidate generation).

Subcommands:
  prepare            Compute the bus corridor route through the 11 mapped stops and
                     write routes/corridor.rou.xml + config/corridor.json.
  scenario <stopId>  Build a CURRENT vs ALTERNATIVE scenario pair for one stop into
                     simulation/scenarios/<stopId>/{current,alternative}/ with a manifest.

Everything is computed from the REAL network (simulation/network/bengaluru.net.xml) and the
stop->edge mapping (simulation/config/stop_edges.json). No geometry is invented (§11).
The ALTERNATIVE stop is a GIS rule-based candidate (relocated toward the nearest major /
signalized junction within a search window, subject to min spacing) — a suitability proxy,
NOT an ML verdict; SUMO validates it (§7, §11).

Run with the SYSTEM python and SUMO tools on the path:
  SUMO_HOME=~/Applications/Sumo/share/sumo PYTHONPATH=$SUMO_HOME/tools \
  /usr/bin/python3 simulation/scripts/sim_build.py prepare
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SIM = os.path.join(ROOT, "simulation")
NET = os.path.join(SIM, "network", "bengaluru.net.xml")
STOP_EDGES = os.path.join(SIM, "config", "stop_edges.json")
CORRIDOR_ROU = os.path.join(SIM, "routes", "corridor.rou.xml")
CORRIDOR_JSON = os.path.join(SIM, "config", "corridor.json")
DEMAND_ROU = os.path.join(SIM, "routes", "demand.rou.xml")
SCEN_ROOT = os.path.join(SIM, "scenarios")

BUS_DWELL_SEC = 20
BUS_PERIOD_SEC = 300  # a bus every 5 minutes
SIM_DURATION = 1500  # long enough for a bus to traverse the ~13km corridor + dwell
CAND_SEARCH_M = 320.0  # window to look for a relocation candidate
MIN_SPACING_M = 140.0  # keep candidates this far from neighbouring stops

try:
    import sumolib
    import sumolib.geomhelper as gh
except ImportError:
    sys.stderr.write("ERROR: need sumolib on PYTHONPATH ($SUMO_HOME/tools)\n")
    raise


def load():
    with open(NET, "rb") as f:
        net = sumolib.net.readNet(f)
    mapping = json.load(open(STOP_EDGES))
    stops = sorted(mapping["stops"], key=lambda s: s["sequence"])
    return net, mapping, stops


def corridor_edges(net, stops):
    """Chain shortest paths between consecutive mapped edges -> one connected corridor.

    Each shortest path from edge A to edge B is a connected list starting at A and ending
    at B. Consecutive segments share their boundary edge, so we append path[1:] to avoid
    duplicating it. We must NOT globally dedupe: a corridor can legitimately pass through
    the same edge twice (e.g. a there-and-back spur), and removing a repeat would splice
    together two edges that are not connected, producing an invalid SUMO route.
    """
    path = []
    for i in range(len(stops) - 1):
        a = stops[i]["sumoEdgeId"]
        b = stops[i + 1]["sumoEdgeId"]
        if a is None or b is None:
            continue
        try:
            edges, _len = net.getShortestPath(
                net.getEdge(a), net.getEdge(b), vClass="bus"
            )
        except Exception:
            edges = None
        if not edges:
            continue
        seg = [e.getID() for e in edges]
        if not path:
            path.extend(seg)
        else:
            # drop the shared boundary edge if it matches the current tail
            if seg and path and seg[0] == path[-1]:
                path.extend(seg[1:])
            else:
                path.extend(seg)
    return path


def cmd_prepare():
    net, mapping, stops = load()
    route = corridor_edges(net, stops)
    if not route:
        sys.stderr.write("ERROR: could not build corridor route\n")
        sys.exit(2)

    order = []
    for s in stops:
        order.append(
            {
                "sequence": s["sequence"],
                "stopId": s["stopId"],
                "name": s["name"],
                "edgeId": s["sumoEdgeId"],
                "laneId": s["sumoLaneId"],
                "position": s["placementPosition"],
                "distanceToRoadM": s["distanceMeters"],
                "feasible": s["feasible"],
                "lat": s["latitude"],
                "lon": s["longitude"],
            }
        )

    # corridor.rou.xml: bus vType + the corridor route (stops are added per-scenario)
    edges_str = " ".join(route)
    with open(CORRIDOR_ROU, "w") as f:
        f.write('<routes xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n')
        f.write('  <vType id="bus" vClass="bus" length="12.0" minGap="2.5" maxSpeed="16.7"\n')
        f.write('          accel="2.0" decel="4.0" sigma="0.4" color="0.1,0.5,0.9"/>\n')
        f.write(f'  <route id="busRoute" edges="{edges_str}"/>\n')
        f.write("</routes>\n")

    json.dump(
        {
            "routeEdges": route,
            "routeEdgeCount": len(route),
            "order": order,
            "busDwellSec": BUS_DWELL_SEC,
            "busPeriodSec": BUS_PERIOD_SEC,
            "simDuration": SIM_DURATION,
        },
        open(CORRIDOR_JSON, "w"),
        indent=2,
    )
    print(f"corridor: {len(route)} edges through {len(order)} stops")
    print(f"wrote {CORRIDOR_ROU}")
    print(f"wrote {CORRIDOR_JSON}")


def junction_score(net, edge):
    """Heuristic 'major junction' score for an edge's downstream node: more connections
    and/or a traffic light = a more significant crossroad (a sensible place for a stop)."""
    score = 0.0
    try:
        to_node = edge.getToNode()
    except Exception:
        return 0.0
    if to_node is None:
        return 0.0
    inc = len(to_node.getIncoming())
    out = len(to_node.getOutgoing())
    score += (inc + out) * 1.5
    try:
        if to_node.getType() == "traffic_light" or to_node.getID() in {
            t.getID() for t in net.getTrafficLights()
        }:
            score += 12.0
    except Exception:
        pass
    return score


def _lane_allows_bus(lane):
    try:
        return lane.allows("bus")
    except Exception:
        return False


def find_candidate(net, route, order, sel):
    """GIS rule-based relocation candidate for the selected stop.

    Walk the corridor within +/- CAND_SEARCH_M of the selected stop's route position and
    pick the edge+position with the highest junction score that is a different edge than
    the current one and keeps MIN_SPACING_M from the neighbouring stops. Returns a dict
    describing the candidate (or None if nothing feasible).
    """
    sel_edge = sel["edgeId"]
    if sel_edge not in route:
        # fall back: nearest route index by edge of the stop
        return None
    sel_idx = route.index(sel_edge)

    # approximate cumulative distance along the corridor to bound the search window
    cum = [0.0]
    for eid in route:
        cum.append(cum[-1] + net.getEdge(eid).getLength())
    sel_pos_route = cum[sel_idx]

    best = None
    lo = max(0, sel_idx - 25)
    hi = min(len(route) - 1, sel_idx + 25)
    for idx in range(lo, hi + 1):
        eid = route[idx]
        if eid == sel_edge:
            continue
        if abs(cum[idx] - sel_pos_route) > CAND_SEARCH_M:
            continue
        edge = net.getEdge(eid)
        lanes = edge.getLanes()
        if not lanes or not edge.allows("bus"):
            continue
        bus_lane = next((l for l in lanes if _lane_allows_bus(l)), None)
        if bus_lane is None:
            continue
        # spacing vs neighbouring stops (in route-distance terms)
        too_close = False
        for o in order:
            if o["stopId"] == sel["stopId"] or o["edgeId"] is None:
                continue
            if o["edgeId"] in route:
                o_idx = route.index(o["edgeId"])
                if abs(cum[o_idx] - cum[idx]) < MIN_SPACING_M:
                    too_close = True
                    break
        if too_close:
            continue
        sc = junction_score(net, edge)
        length = bus_lane.getLength()
        pos = min(max(length * 0.5, 5.0), max(length - 5.0, 5.0))
        cand = {
            "edgeId": eid,
            "laneId": bus_lane.getID(),
            "position": round(pos, 2),
            "edgeLength": round(length, 2),
            "junctionScore": round(sc, 2),
            "routeIndex": idx,
            "shiftAlongCorridorM": round(cum[idx] - sel_pos_route, 1),
        }
        if best is None or sc > best["junctionScore"]:
            best = cand
    if best is not None:
        # lon/lat of the candidate position (real projection) on the chosen bus lane
        lane = net.getLane(best["laneId"])
        xy = gh.positionAtShapeOffset(lane.getShape(), best["position"])
        lon, lat = net.convertXY2LonLat(xy[0], xy[1])
        best["lon"] = round(lon, 6)
        best["lat"] = round(lat, 6)
    return best


def write_add_file(path, order, net=None, override_stop_id=None, override=None):
    """Write a SUMO additional file with <busStop> elements. If override_stop_id is set,
    that stop's busStop uses the override edge/lane/position (the ALTERNATIVE).
    Positions are clamped to the real lane length so SUMO never rejects a stop."""
    with open(path, "w") as f:
        f.write('<additional xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n')
        for o in order:
            if o["laneId"] is None:
                continue
            sid = f"sb_{o['sequence']:02d}"
            lane = o["laneId"]
            pos = o["position"]
            name = o["name"]
            if override_stop_id and o["stopId"] == override_stop_id and override:
                lane = override["laneId"]
                pos = override["position"]
                name = f"{o['name']} (recommended)"
            lane_len = None
            if net is not None:
                try:
                    lane_len = net.getLane(lane).getLength()
                except Exception:
                    lane_len = None
            span = 20.0
            if lane_len is not None:
                span = min(20.0, max(5.0, lane_len - 1.0))
                end = min(max(pos + span / 2.0, span), max(lane_len - 0.5, span))
                start = max(0.0, end - span)
                end = start + span
                if end > lane_len:
                    end = lane_len
                    start = max(0.0, end - span)
            else:
                start = max(0.0, pos - 10.0)
                end = start + span
            f.write(
                f'  <busStop id="{sid}" lane="{lane}" startPos="{start:.2f}" '
                f'endPos="{end:.2f}" name="{escape(name)}"/>\n'
            )
        f.write("</additional>\n")


def escape(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def write_buses(path, order, begin=0, count=None, period=BUS_PERIOD_SEC):
    """Write bus vehicles that run the corridor and stop at every busStop in order.
    The bus vType and busRoute definitions are inlined so the file is self-contained."""
    if count is None:
        count = max(1, SIM_DURATION // period)
    defs = []
    if os.path.exists(CORRIDOR_ROU):
        import re
        with open(CORRIDOR_ROU) as cf:
            text = cf.read()
        for tag in ("vType", "route"):
            for m in re.finditer(r"<%s\b[^>]*/>" % tag, text, re.S):
                defs.append(m.group(0))
    with open(path, "w") as f:
        f.write('<routes xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n')
        for d in defs:
            f.write(d + "\n")
        for k in range(count):
            dep = begin + k * period
            f.write(f'  <vehicle id="bus{k}" type="bus" route="busRoute" depart="{dep}" departSpeed="0">\n')
            for o in order:
                if o["laneId"] is None:
                    continue
                f.write(f'    <stop busStop="sb_{o["sequence"]:02d}" duration="{BUS_DWELL_SEC}"/>\n')
            f.write("  </vehicle>\n")
        f.write("</routes>\n")


def write_sumocfg(path, net_rel, add_rel, buses_rel, demand_rel, label):
    with open(path, "w") as f:
        f.write('<configuration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n')
        f.write("  <input>\n")
        f.write(f'    <net-file value="{net_rel}"/>\n')
        inputs = [add_rel, buses_rel]
        if demand_rel:
            inputs.append(demand_rel)
        f.write(f'    <additional-files value="{",".join(inputs)}"/>\n')
        f.write("  </input>\n")
        f.write("  <time>\n")
        f.write(f'    <begin value="0"/>\n    <end value="{SIM_DURATION}"/>\n')
        f.write("  </time>\n")
        f.write("  <processing>\n")
        f.write('    <collision.action value="warn"/>\n')
        f.write("  </processing>\n")
        f.write(f'  <report>\n    <no-step-log value="true"/>\n  </report>\n')
        f.write("</configuration>\n")


def cmd_scenario(stop_id):
    net, mapping, stops = load()
    corridor = json.load(open(CORRIDOR_JSON))
    order = corridor["order"]
    sel = next((o for o in order if o["stopId"] == stop_id), None)
    if sel is None:
        sys.stderr.write(f"ERROR: stopId not in corridor: {stop_id}\n")
        sys.exit(3)

    outdir = os.path.join(SCEN_ROOT, stop_id)
    cur = os.path.join(outdir, "current")
    alt = os.path.join(outdir, "alternative")
    os.makedirs(cur, exist_ok=True)
    os.makedirs(alt, exist_ok=True)

    # relative paths from each scenario dir back to network/routes (3 levels up)
    rel = "../../../"
    net_rel = rel + "network/bengaluru.net.xml"
    demand_rel = rel + "routes/demand.rou.xml" if os.path.exists(DEMAND_ROU) else None

    # CURRENT
    write_add_file(os.path.join(cur, "stops.add.xml"), order, net)
    write_buses(os.path.join(cur, "buses.rou.xml"), order)
    write_sumocfg(
        os.path.join(cur, "scenario.sumocfg"), net_rel, "stops.add.xml",
        "buses.rou.xml", demand_rel, f"SmartBusOpt CURRENT — {sel['name']}",
    )

    # ALTERNATIVE (GIS candidate relocation for the selected stop)
    cand = find_candidate(net, corridor["routeEdges"], order, sel)
    manifest = {
        "stopId": stop_id,
        "selected": sel,
        "candidate": cand,
        "candidateProvenance": "GIS rule-based relocation toward nearest major/signalized "
                               "junction within %.0fm, min spacing %.0fm. Suitability proxy — "
                               "NOT an ML verdict; validated by SUMO." % (CAND_SEARCH_M, MIN_SPACING_M),
        "simDuration": SIM_DURATION,
        "busDwellSec": BUS_DWELL_SEC,
        "busPeriodSec": BUS_PERIOD_SEC,
        "demand": {"file": "routes/demand.rou.xml", "provenance": "synthetic (randomTrips, seed 42)"},
        "network": {"file": "network/bengaluru.net.xml", "provenance": "OSM-derived (netconvert)"},
    }
    if cand is None:
        manifest["alternativeFeasible"] = False
        manifest["note"] = ("No feasible relocation candidate on the corridor within the search "
                            "window (spacing/junction constraints). Alternative == current; the UI "
                            "must say so rather than fabricate an improvement (§2.2, §11).")
        # alternative mirrors current so a run still works, but flagged identical
        write_add_file(os.path.join(alt, "stops.add.xml"), order, net)
    else:
        manifest["alternativeFeasible"] = True
        write_add_file(os.path.join(alt, "stops.add.xml"), order, net,
                       override_stop_id=stop_id, override=cand)
    write_buses(os.path.join(alt, "buses.rou.xml"), order)
    write_sumocfg(
        os.path.join(alt, "scenario.sumocfg"), net_rel, "stops.add.xml",
        "buses.rou.xml", demand_rel, f"SmartBusOpt ALTERNATIVE — {sel['name']}",
    )

    json.dump(manifest, open(os.path.join(outdir, "manifest.json"), "w"), indent=2)
    print(f"scenario for {sel['name']} ({stop_id})")
    print(f"  candidate: {cand['edgeId'] if cand else 'NONE'} "
          f"shift={cand['shiftAlongCorridorM'] if cand else '-'}m "
          f"score={cand['junctionScore'] if cand else '-'}")
    print(f"  wrote {outdir}")


def cmd_geojson():
    """Export the corridor route + mapped stops to GeoJSON (lon/lat via the network's own
    projection) so the frontend can draw real geometry on a real map. No geometry invented."""
    net, mapping, stops = load()
    corridor = json.load(open(CORRIDOR_JSON))
    route = corridor["routeEdges"]
    features = []

    # corridor as one MultiLineString of consecutive edge shapes (dedup shared boundary pts)
    coords = []
    for eid in route:
        try:
            shape = net.getEdge(eid).getShape()
        except Exception:
            continue
        for pt in shape:
            lon, lat = net.convertXY2LonLat(pt[0], pt[1])
            ll = [round(lon, 6), round(lat, 6)]
            if not coords or coords[-1] != ll:
                coords.append(ll)
    features.append({
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {"kind": "corridor", "edgeCount": len(route),
                       "provenance": "OSM-derived network, corridor route computed by sumolib"},
    })

    for s in stops:
        if s["sumoLaneId"] is None:
            continue
        try:
            lane = net.getLane(s["sumoLaneId"])
            xy = gh.positionAtShapeOffset(lane.getShape(), s["placementPosition"])
            lon, lat = net.convertXY2LonLat(xy[0], xy[1])
        except Exception:
            lon, lat = s["longitude"], s["latitude"]
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
            "properties": {
                "kind": "stop",
                "stopId": s["stopId"],
                "name": s["name"],
                "sequence": s["sequence"],
                "edgeId": s["sumoEdgeId"],
                "laneId": s["sumoLaneId"],
                "distanceToRoadM": s["distanceMeters"],
                "feasible": s["feasible"],
                "sourceLat": s["latitude"],
                "sourceLon": s["longitude"],
                "provenance": "stop coords sourced/corrected; snapped to real SUMO lane",
            },
        })

    out = os.path.join(SIM, "config", "corridor.geojson")
    json.dump({"type": "FeatureCollection", "features": features}, open(out, "w"))
    print(f"geojson: {len(features)} features -> {out}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "prepare":
        cmd_prepare()
    elif cmd == "geojson":
        cmd_geojson()
    elif cmd == "scenario":
        if len(sys.argv) < 3:
            sys.stderr.write("usage: sim_build.py scenario <stopId>\n")
            sys.exit(1)
        cmd_scenario(sys.argv[2])
    else:
        sys.stderr.write(f"unknown command: {cmd}\n")
        sys.exit(1)
