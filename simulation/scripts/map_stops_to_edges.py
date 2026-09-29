#!/usr/bin/env python3
"""
Stop-to-edge mapping + network validation (build prompt §5.3, §5.2).

Loads the real SUMO network with sumolib, validates it, and maps each unique bus stop
(corrected lat/lon from the normalized dataset) to the nearest valid SUMO edge/lane.
Stops too far from the network are FLAGGED, never force-placed (§5.3, §11).

Run with the SYSTEM python (Homebrew py3.14 has a broken XML parser):
  SUMO_HOME=~/Applications/Sumo/share/sumo \
  PYTHONPATH=$SUMO_HOME/tools \
  /usr/bin/python3 simulation/scripts/map_stops_to_edges.py

Output: simulation/config/stop_edges.json
"""
import json
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
NET = os.path.join(ROOT, "simulation", "network", "bengaluru.net.xml")
STOPS = os.path.join(ROOT, "server", "data", "stops.normalized.generated.json")
OUT = os.path.join(ROOT, "simulation", "config", "stop_edges.json")

MAX_WALK_M = 120.0  # reject stops farther than this from any road edge (§5.3)
GRID = 150.0  # spatial index cell size (m)

try:
    import sumolib
    import sumolib.geomhelper as gh
except ImportError:
    sys.stderr.write(
        "ERROR: sumolib not importable. Set PYTHONPATH=$SUMO_HOME/tools and use a Python "
        "with a working XML parser (e.g. /usr/bin/python3).\n"
    )
    raise


def unique_stops(path):
    ds = json.load(open(path))
    by_name = {}
    for s in ds["stops"]:
        if s["Bus_Stop_Name"] not in by_name or s["Observation"] == 1:
            by_name[s["Bus_Stop_Name"]] = s
    return list(by_name.values())


def street_name(edge):
    for key in ("street.name", "name"):
        try:
            v = edge.getParam(key)
            if v:
                return v
        except Exception:
            pass
    return None


def build_grid(edges):
    """Bucket bus-allowed edges into grid cells by their shape bounding box."""
    grid = defaultdict(list)
    for e in edges:
        try:
            if not e.allows("bus"):
                continue
        except Exception:
            continue
        shape = e.getShape()
        if not shape or len(shape) < 2:
            continue
        xs = [p[0] for p in shape]
        ys = [p[1] for p in shape]
        gx0, gx1 = int(min(xs) // GRID), int(max(xs) // GRID)
        gy0, gy1 = int(min(ys) // GRID), int(max(ys) // GRID)
        for gx in range(gx0, gx1 + 1):
            for gy in range(gy0, gy1 + 1):
                grid[(gx, gy)].append(e)
    return grid


def nearest_edge(grid, x, y, search_cells):
    best = None  # (dist, offset, edge)
    gx, gy = int(x // GRID), int(y // GRID)
    seen = set()
    for r in range(search_cells + 1):
        for cx in range(gx - r, gx + r + 1):
            for cy in range(gy - r, gy + r + 1):
                for e in grid.get((cx, cy), []):
                    eid = e.getID()
                    if eid in seen:
                        continue
                    seen.add(eid)
                    try:
                        shape = e.getShape()
                        dist = gh.distancePointToPolygon((x, y), shape)
                        offset = gh.polygonOffsetWithMinimumDistanceToPoint((x, y), shape)
                    except Exception:
                        continue
                    if best is None or dist < best[0]:
                        best = (dist, offset, e)
    return best


def main():
    if not os.path.exists(NET):
        sys.stderr.write(f"ERROR: network not found: {NET}\n")
        sys.exit(2)
    with open(NET, "rb") as f:
        net = sumolib.net.readNet(f)

    edges = net.getEdges()
    nodes = net.getNodes()
    tls = net.getTrafficLights()

    xmin, ymin, xmax, ymax = net.getBoundary()
    w_lon, s_lat = net.convertXY2LonLat(xmin, ymin)
    e_lon, n_lat = net.convertXY2LonLat(xmax, ymax)
    validation = {
        "networkFile": NET,
        "edgeCount": len(edges),
        "laneCount": sum(len(e.getLanes()) for e in edges),
        "junctionCount": len(nodes),
        "tlsCount": len(tls),
        "bounds_lonlat": [round(w_lon, 6), round(s_lat, 6), round(e_lon, 6), round(n_lat, 6)],
        "hasGeoProjection": net.hasGeoProj(),
    }

    grid = build_grid(edges)
    bus_edges = sum(len(set(id(e) for e in cell)) for cell in grid.values())

    mappings = []
    for s in unique_stops(STOPS):
        lat, lon = s["Latitude_Est"], s["Longitude_Est"]
        x, y = net.convertLonLat2XY(lon, lat)
        entry = {
            "stopId": s["Stop_Id"],
            "name": s["Bus_Stop_Name"],
            "sequence": s["Sequence"],
            "latitude": lat,
            "longitude": lon,
            "x": round(x, 2),
            "y": round(y, 2),
            "sumoEdgeId": None,
            "sumoLaneId": None,
            "distanceMeters": None,
            "edgeLength": None,
            "edgeName": None,
            "placementPosition": None,
            "feasible": False,
            "reason": None,
        }
        # search radius: enough cells to cover MAX_WALK_M, widened if nothing found
        best = nearest_edge(grid, x, y, search_cells=int(MAX_WALK_M // GRID) + 1)
        if best is None:
            best = nearest_edge(grid, x, y, search_cells=int((MAX_WALK_M * 6) // GRID) + 1)
        if best is not None:
            dist, offset, edge = best
            lanes = edge.getLanes()
            # pick a lane the bus can actually stop on (lane 0 is often a sidewalk)
            lane = None
            for cand in lanes:
                try:
                    if cand.allows("bus"):
                        lane = cand
                        break
                except Exception:
                    continue
            if lane is None and lanes:
                lane = lanes[-1]
            length = edge.getLength()
            pos = min(max(offset, 5.0), max(length - 5.0, 5.0))
            entry.update(
                {
                    "sumoEdgeId": edge.getID(),
                    "sumoLaneId": lane.getID() if lane else None,
                    "distanceMeters": round(dist, 2),
                    "edgeLength": round(length, 2),
                    "edgeName": street_name(edge),
                    "placementPosition": round(pos, 2),
                    "feasible": dist <= MAX_WALK_M and lane is not None,
                    "reason": None
                    if dist <= MAX_WALK_M
                    else f"nearest bus-allowed edge is {dist:.0f}m away (> {MAX_WALK_M:.0f}m threshold)",
                }
            )
        else:
            entry["reason"] = "no bus-allowed edge found within search radius"
        mappings.append(entry)

    feasible = [m for m in mappings if m["feasible"]]
    result = {
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "network": validation,
        "maxWalkMeters": MAX_WALK_M,
        "busAllowedEdgesIndexed": bus_edges,
        "stopCount": len(mappings),
        "feasibleCount": len(feasible),
        "stops": mappings,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(result, open(OUT, "w"), indent=2)

    print(f"network: {validation['edgeCount']} edges, {validation['laneCount']} lanes, "
          f"{validation['junctionCount']} junctions, {validation['tlsCount']} TLS, "
          f"geoProj={validation['hasGeoProjection']}")
    print(f"bus-allowed edges indexed: {bus_edges}")
    print(f"stops mapped: {len(feasible)}/{len(mappings)} feasible (<= {MAX_WALK_M:.0f}m)")
    for m in mappings:
        flag = "OK " if m["feasible"] else "FLAG"
        d = m["distanceMeters"]
        print(f"  [{flag}] seq{m['sequence']:>2} {m['name'][:34]:36} "
              f"edge={str(m['sumoEdgeId'])[:20]:22} dist={d if d is None else round(d,1)}m")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
