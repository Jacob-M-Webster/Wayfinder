#!/usr/bin/env python3
"""
Turn Waymo's per-LANE signals into per-DIRECTION (N/E/S/W) signals.

  lane_geometry(sc)            stop point + travel heading of every signal-controlled lane
  group_intersections(geom)    cluster lanes into intersections, bin into N/E/S/W approaches
  true_timeline(sc, inter)     true phase per approach per step   (-> beacon timeline)
  combine_lane_predictions()   model's lane probabilities -> approach phase + confidence

Direction names = direction of TRAVEL in the scenario's local map frame (+x = "E", +y = "N").
So "N" means northbound traffic. Waymo's frame is NOT true compass north; that's fine
as long as the whole team uses the same convention.

Quick check (run from the folder with extract_features.py):
  python approaches.py --shard D:/waymo_data/uncompressed/scenario/training/training.tfrecord-00040-of-01000 --index 0
Add --export timeline.json to write the beacon file for that scenario.
"""
import argparse
import json
import math
from collections import Counter, defaultdict

import numpy as np
from waymo_open_dataset.protos import scenario_pb2

from extract_features import LABEL_MAP, lane_direction, read_tfrecord

APPROACHES = ["N", "E", "S", "W"]          # also the order used in the beacon packet
LINK_RADIUS = 30.0                         # m: stop points closer than this = same intersection
SAFETY = {"STOP": 2, "CAUTION": 1, "GO": 0}  # tie-break toward the safer state
PHASE_CODE = {"UNKNOWN": 0, "NONE": 0, "STOP": 1, "CAUTION": 2, "GO": 3}  # 2-bit packet codes


def approach_of(heading_rad):
    deg = (math.degrees(heading_rad) + 360) % 360
    return ["E", "N", "W", "S"][int(((deg + 45) % 360) // 90)]


def load_scenario(path, index=0, scenario_id=None):
    for i, raw in enumerate(read_tfrecord(path)):
        sc = scenario_pb2.Scenario.FromString(raw)
        if (scenario_id and sc.scenario_id == scenario_id) or (not scenario_id and i == index):
            return sc
    raise ValueError("scenario not found in shard")


def lane_geometry(sc):
    """{lane_id: ((stop_x, stop_y), heading_rad)} for every signal-controlled lane."""
    stops = {}
    for dms in sc.dynamic_map_states:
        for ls in dms.lane_states:
            stops.setdefault(ls.lane, (ls.stop_point.x, ls.stop_point.y))
    poly = {mf.id: np.array([(p.x, p.y) for p in mf.lane.polyline])
            for mf in sc.map_features
            if mf.WhichOneof("feature_data") == "lane" and mf.id in stops}
    geom = {}
    for lid, stop in stops.items():
        d = lane_direction(poly.get(lid), stop)
        if d is not None:
            geom[lid] = (stop, math.atan2(d[1], d[0]))
    return geom


def group_intersections(geom, radius=LINK_RADIUS):
    """Cluster stop points into intersections (largest first), bin lanes by travel direction."""
    ids = list(geom)
    parent = {l: l for l in ids}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for i, a in enumerate(ids):
        (xa, ya), _ = geom[a]
        for b in ids[i + 1:]:
            (xb, yb), _ = geom[b]
            if math.hypot(xa - xb, ya - yb) < radius:
                parent[find(a)] = find(b)

    groups = defaultdict(list)
    for l in ids:
        groups[find(l)].append(l)

    inters = []
    for n, lanes in enumerate(sorted(groups.values(), key=len, reverse=True)):
        appr = defaultdict(list)
        for l in lanes:
            appr[approach_of(geom[l][1])].append(l)
        center = np.mean([geom[l][0] for l in lanes], axis=0)
        inters.append({"id": n, "center": [round(float(c), 1) for c in center],
                       "lanes": lanes, "approaches": dict(appr)})
    return inters


def _vote(counter):
    return max(counter, key=lambda k: (counter[k], SAFETY[k]))


def true_timeline(sc, inter, merge_caution=False):
    """List (one per step) of {approach: phase}. Majority vote across the approach's lanes.
    UNKNOWN = approach has lights but no label this step; NONE = no lights on that approach."""
    lane_to_appr = {l: a for a, ls in inter["approaches"].items() for l in ls}
    timeline = []
    for dms in sc.dynamic_map_states:
        votes = defaultdict(Counter)
        for ls in dms.lane_states:
            a = lane_to_appr.get(ls.lane)
            if a and ls.state in LABEL_MAP:
                lab = LABEL_MAP[ls.state]
                if merge_caution and lab == "CAUTION":
                    lab = "STOP"
                votes[a][lab] += 1
        step = {}
        for a in APPROACHES:
            if a not in inter["approaches"]:
                step[a] = "NONE"
            else:
                step[a] = _vote(votes[a]) if votes[a] else "UNKNOWN"
        timeline.append(step)
    return timeline


def combine_lane_predictions(lane_probs, inter):
    """lane_probs: {lane_id: {"STOP": p, "GO": p}} for lanes WITH evidence (skip no-evidence lanes).
    Returns {approach: (phase, confidence)}. Plain average of the lanes' probabilities."""
    out = {}
    for a in APPROACHES:
        ps = [lane_probs[l] for l in inter["approaches"].get(a, []) if l in lane_probs]
        if not ps:
            out[a] = ("UNKNOWN", 0.0)
            continue
        avg = {c: float(np.mean([p[c] for p in ps])) for c in ps[0]}
        best = max(avg, key=lambda c: (avg[c], SAFETY.get(c, 0)))
        out[a] = (best, round(avg[best], 3))
    return out


def export_timeline(sc, inter, timeline, path):
    data = {"scenario_id": sc.scenario_id, "intersection_id": inter["id"], "hz": 10,
            "approach_order": APPROACHES,
            "codes": {"0": "UNKNOWN/NONE", "1": "STOP", "2": "CAUTION", "3": "GO"},
            "steps": [[PHASE_CODE[s[a]] for a in APPROACHES] for s in timeline]}
    with open(path, "w") as f:
        json.dump(data, f)


def ego_lane(sc, inter, geom, back=60.0, fwd=2.0, lat_tol=2.5,
             head_tol=math.radians(35)):
    """Which signal-controlled lane the Waymo car is approaching in.
    At every step, finds the intersection lane whose approach zone the car sits in
    (up to 60 m before that lane's stop line, lined up with it). If several lanes qualify
    (neighbors), the one the car is most centered in wins. Returns the lane seen most
    often, or None if the car never approaches one of this intersection's lights."""
    if not (0 <= sc.sdc_track_index < len(sc.tracks)):
        return None
    sdc = sc.tracks[sc.sdc_track_index]
    lanes = [(l, geom[l][0], geom[l][1]) for ls in inter["approaches"].values()
             for l in ls if l in geom]
    votes = Counter()
    for st in sdc.states:
        if not st.valid:
            continue
        best, best_lat = None, lat_tol
        for l, (sx, sy), h in lanes:
            dx, dy = st.center_x - sx, st.center_y - sy
            s = dx * math.cos(h) + dy * math.sin(h)
            lat = abs(-dx * math.sin(h) + dy * math.cos(h))
            dh = abs((st.heading - h + math.pi) % (2 * math.pi) - math.pi)
            if -back < s < fwd and lat < best_lat and dh < head_tol:
                best, best_lat = l, lat
        if best is not None:
            votes[best] += 1
    return votes.most_common(1)[0][0] if votes else None


def ego_approach(sc, inter, geom):
    """Direction (N/E/S/W) of the Waymo car's lane, or None."""
    lane = ego_lane(sc, inter, geom)
    if lane is None:
        return None
    return next(d for d, ls in inter["approaches"].items() if lane in ls)


def lane_truth_series(sc, lane_id, merge_caution=False):
    """True state of ONE lane's light at every step (UNKNOWN when unlabeled)."""
    out = []
    for dms in sc.dynamic_map_states:
        s = next((ls.state for ls in dms.lane_states if ls.lane == lane_id), 0)
        lab = LABEL_MAP.get(s, "UNKNOWN")
        if merge_caution and lab == "CAUTION":
            lab = "STOP"
        out.append(lab)
    return out


TYPE_NAMES = {1: "vehicle", 2: "pedestrian", 3: "cyclist"}
SCENE_RADIUS = 80.0   # m around the intersection center to include in the scene


def _near(pts, c, r):
    return len(pts) > 0 and float(np.min(np.hypot(pts[:, 0] - c[0], pts[:, 1] - c[1]))) < r


def export_scene(sc, inter, geom, timeline, path, radius=SCENE_RADIUS):
    """Everything the dashboard needs to draw a top-down replay of one intersection."""
    cx, cy = inter["center"]

    def rel(x, y):
        return [round(x - cx, 2), round(y - cy, 2)]

    lane_to_appr = {l: a for a, ls in inter["approaches"].items() for l in ls}

    map_out = {"lanes": [], "road_edges": [], "crosswalks": []}
    for mf in sc.map_features:
        kind = mf.WhichOneof("feature_data")
        if kind == "lane":
            pts = mf.lane.polyline
        elif kind == "road_edge":
            pts = mf.road_edge.polyline
        elif kind == "crosswalk":
            pts = mf.crosswalk.polygon
        else:
            continue
        arr = np.array([(p.x, p.y) for p in pts])
        if not _near(arr, (cx, cy), radius):
            continue
        item = {"id": mf.id, "points": [rel(x, y) for x, y in arr]}
        if kind == "lane":
            item["controlled"] = mf.id in lane_to_appr
            map_out["lanes"].append(item)
        elif kind == "road_edge":
            map_out["road_edges"].append(item)
        else:
            map_out["crosswalks"].append(item)

    signals = [{"lane_id": l, "approach": a, "stop": rel(*geom[l][0]),
                "heading": round(geom[l][1], 3)}
               for a, ls in inter["approaches"].items() for l in ls]

    lane_truth = [{str(ls.lane): LABEL_MAP.get(ls.state, "UNKNOWN")
                   for ls in dms.lane_states if ls.lane in lane_to_appr}
                  for dms in sc.dynamic_map_states]

    agents = []
    for i, tr in enumerate(sc.tracks):
        xy = np.array([(s.center_x, s.center_y) for s in tr.states if s.valid])
        if not _near(xy, (cx, cy), radius):
            continue
        first = next(s for s in tr.states if s.valid)
        agents.append({
            "id": tr.id,
            "type": TYPE_NAMES.get(tr.object_type, "other"),
            "is_sdc": i == sc.sdc_track_index,
            "length": round(first.length, 2),
            "width": round(first.width, 2),
            # one entry per step: [x, y, heading] or null when the agent isn't visible
            "states": [[*rel(s.center_x, s.center_y), round(s.heading, 3)] if s.valid else None
                       for s in tr.states],
        })

    scene = {
        "scenario_id": sc.scenario_id,
        "intersection_id": inter["id"],
        "hz": 10,
        "num_steps": len(timeline),
        "units": "meters relative to intersection center; +x = E, +y = N; "
                 "heading in radians, counter-clockwise from +x",
        "approach_order": APPROACHES,
        "ego_lane": ego_lane(sc, inter, geom),
        "ego_approach": ego_approach(sc, inter, geom),
        "map": map_out,
        "signals": signals,
        "agents": agents,
        "truth": {"approach": timeline, "lane": lane_truth},
    }
    with open(path, "w") as f:
        json.dump(scene, f, separators=(",", ":"))


def scan(path, limit):
    """List scenarios whose main intersection has at least one light change."""
    found = 0
    for i, raw in enumerate(read_tfrecord(path)):
        sc = scenario_pb2.Scenario.FromString(raw)
        inters = group_intersections(lane_geometry(sc))
        if not inters:
            continue
        tl = true_timeline(sc, inters[0])
        changes = sum(1 for x, y in zip(tl, tl[1:]) if x != y)
        if changes == 0:
            continue
        cx, cy = inters[0]["center"]
        n_veh = sum(1 for tr in sc.tracks if tr.object_type == 1 and any(
            s.valid and math.hypot(s.center_x - cx, s.center_y - cy) < 40 for s in tr.states))
        print(f"  --index {i:<4d} {sc.scenario_id}  light changes={changes}  vehicles near={n_veh}")
        found += 1
        if found >= limit:
            return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", required=True)
    ap.add_argument("--index", type=int, default=0, help="scenario index within the shard")
    ap.add_argument("--scenario-id", default=None)
    ap.add_argument("--inter", type=int, default=0, help="which intersection (0 = largest)")
    ap.add_argument("--export", default=None, help="write beacon timeline JSON here")
    ap.add_argument("--scene", default=None, help="write dashboard scene JSON here")
    ap.add_argument("--find", type=int, default=0,
                    help="list the first N scenarios with a light change, then exit")
    a = ap.parse_args()

    if a.find:
        scan(a.shard, a.find)
        return

    sc = load_scenario(a.shard, a.index, a.scenario_id)
    geom = lane_geometry(sc)
    inters = group_intersections(geom)
    print(f"scenario {sc.scenario_id}: {len(inters)} intersection(s)")
    if not inters:
        print("no signal-controlled lanes in this scenario; try another --index")
        return
    for it in inters:
        counts = {k: len(v) for k, v in sorted(it["approaches"].items())}
        print(f"  #{it['id']} center={it['center']} lanes={len(it['lanes'])} by approach={counts}")

    inter = inters[a.inter]
    el = ego_lane(sc, inter, geom)
    if el is None:
        print("\nWaymo car: not approaching one of this intersection's lights")
    else:
        print(f"\nWaymo car approaching from: {ego_approach(sc, inter, geom)} (lane {el})")
    tl = true_timeline(sc, inter)
    print(f"\ntrue timeline for intersection #{inter['id']} (printed only when something changes):")
    prev = None
    for t, step in enumerate(tl):
        if step != prev:
            print(f"  t={t / 10:4.1f}s  " + "  ".join(f"{k}={step[k]:<7}" for k in APPROACHES))
            prev = step

    if a.export:
        export_timeline(sc, inter, tl, a.export)
        print(f"\nwrote {a.export} ({len(tl)} steps)")
    if a.scene:
        export_scene(sc, inter, geom, tl, a.scene)
        print(f"wrote {a.scene}")


if __name__ == "__main__":
    main()
