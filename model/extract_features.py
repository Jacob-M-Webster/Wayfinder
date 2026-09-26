#!/usr/bin/env python3
"""
Extract per-(controlled lane, timestep) behavioral features + signal labels
from Waymo Open Motion Dataset scenario shards.

Usage (debug first!):
  python extract_features.py --data waymo_data/scenario/training --out feats \
      --shards 0 --max-scenarios 50 --workers 1
Then scale:
  python extract_features.py --data waymo_data/scenario/training --out feats \
      --shards 0-29 --workers 12

Output: one parquet per shard in --out. Resumable (skips shards already done).
"""
import argparse
import glob
import math
import os
import re
import struct
import time
from multiprocessing import Pool

import numpy as np
import pandas as pd
from waymo_open_dataset.protos import scenario_pb2

# Raw LaneState enum -> class. 0 = UNKNOWN (dropped).
LABEL_MAP = {1: "STOP", 4: "STOP", 7: "STOP",          # arrow stop, stop, flashing stop
             2: "CAUTION", 5: "CAUTION", 8: "CAUTION",  # arrow caution, caution, flashing caution
             3: "GO", 6: "GO"}                          # arrow go, go

TYPE_VEHICLE = 1
APPROACH_BACK = 40.0     # m upstream of stop line = queue region
APPROACH_FWD = 2.0       # m past the line still counted as approach
CROSS_FWD = 30.0         # m past the line = "crossing" region
LAT_TOL = 1.8            # m lateral tolerance (~half a lane)
HEAD_TOL = math.radians(30)
STOP_SPEED = 0.5         # m/s
MOVE_SPEED = 2.0         # m/s
CONTEXT_RADIUS = 60.0    # m, other lanes considered part of same intersection
STEP = 5                 # sample every 0.5 s (adjacent frames are near-duplicates)
LOOKBACK = 10            # 1.0 s for temporal deltas

NAN = float("nan")


def read_tfrecord(path):
    """Minimal uncompressed TFRecord reader, no TensorFlow required."""
    with open(path, "rb") as f:
        while True:
            header = f.read(12)
            if len(header) < 12:
                return
            (length,) = struct.unpack("<Q", header[:8])
            data = f.read(length)
            f.read(4)  # data crc
            yield data


def wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


def track_arrays(sc):
    """Non-SDC vehicle tracks as (N, T) arrays. SDC excluded: its motion leaks the label."""
    sdc = sc.sdc_track_index
    tracks = [tr for i, tr in enumerate(sc.tracks)
              if i != sdc and tr.object_type == TYPE_VEHICLE]
    if not tracks:
        return None
    T = len(tracks[0].states)
    x = np.zeros((len(tracks), T), np.float32)
    y, spd, hd = x.copy(), x.copy(), x.copy()
    valid = np.zeros((len(tracks), T), bool)
    for n, tr in enumerate(tracks):
        for t, st in enumerate(tr.states[:T]):
            if st.valid:
                x[n, t], y[n, t] = st.center_x, st.center_y
                spd[n, t] = math.hypot(st.velocity_x, st.velocity_y)
                hd[n, t] = st.heading
                valid[n, t] = True
    return x, y, spd, hd, valid


def lane_direction(poly, stop):
    """Unit direction of travel of the lane at its stop point."""
    if poly is None or len(poly) < 2:
        return None
    i = int(np.argmin(np.hypot(poly[:, 0] - stop[0], poly[:, 1] - stop[1])))
    a, b = i, min(i + 3, len(poly) - 1)
    if b == a:
        a = max(i - 3, 0)
    v = poly[b] - poly[a]
    n = np.hypot(*v)
    return None if n < 1e-3 else v / n


def regions(stop, d, head, x, y, spd, hd, valid):
    """Longitudinal position + approach/crossing masks in the stop-line frame."""
    dx, dy = x - stop[0], y - stop[1]
    s = dx * d[0] + dy * d[1]
    lat = -dx * d[1] + dy * d[0]
    on = valid & (np.abs(lat) < LAT_TOL) & (np.abs(wrap(hd - head)) < HEAD_TOL)
    app = on & (s > -APPROACH_BACK) & (s < APPROACH_FWD)
    crs = on & (s >= APPROACH_FWD) & (s < CROSS_FWD) & (spd > MOVE_SPEED)
    return s, app, crs


def lane_features(stop, d, head, P, t):
    x, y, spd, hd, valid = P
    tp = t - LOOKBACK
    s, app, crs = regions(stop, d, head, x[:, t], y[:, t], spd[:, t], hd[:, t], valid[:, t])
    _, app0, crs0 = regions(stop, d, head, x[:, tp], y[:, tp], spd[:, tp], hd[:, tp], valid[:, tp])

    f = {"n_app": int(app.sum()), "n_crs": int(crs.sum()),
         "n_app_prev": int(app0.sum()), "n_crs_prev": int(crs0.sum())}
    if app.any():
        sp = spd[app, t]
        f["n_app_stopped"] = int((sp < STOP_SPEED).sum())
        f["app_frac_stopped"] = float((sp < STOP_SPEED).mean())
        f["app_mean_spd"] = float(sp.mean())
        idx = np.where(app)[0]
        lead = idx[np.argmax(s[idx])]                     # vehicle closest to the line
        f["lead_dist"] = float(-s[lead])
        f["lead_spd"] = float(spd[lead, t])
        f["lead_dspd"] = float(spd[lead, t] - spd[lead, tp]) if valid[lead, tp] else NAN
    else:
        f.update(n_app_stopped=0, app_frac_stopped=NAN, app_mean_spd=NAN,
                 lead_dist=NAN, lead_spd=NAN, lead_dspd=NAN)
    f["crs_mean_spd"] = float(spd[crs, t].mean()) if crs.any() else NAN
    return f


def scenario_context(sc):
    """Per-scenario data shared by every step: tracks, controlled-lane polylines, caches."""
    P = track_arrays(sc)
    if P is None:
        return None
    T = min(len(sc.dynamic_map_states), P[0].shape[1])
    controlled = {ls.lane for dms in sc.dynamic_map_states for ls in dms.lane_states}
    poly = {mf.id: np.array([(p.x, p.y) for p in mf.lane.polyline])
            for mf in sc.map_features
            if mf.WhichOneof("feature_data") == "lane" and mf.id in controlled}
    return {"P": P, "T": T, "poly": poly, "dir_cache": {}}


def step_features(sc, S, t):
    """Features for EVERY controlled lane at step t (t >= LOOKBACK), labeled or not.
    Returns [(lane_id, raw_state, feature_dict), ...]. Used by training AND live inference,
    so both always compute features the exact same way."""
    P, poly, dir_cache = S["P"], S["poly"], S["dir_cache"]
    lanes = []
    for ls in sc.dynamic_map_states[t].lane_states:
        stop = (ls.stop_point.x, ls.stop_point.y)
        key = (ls.lane, round(stop[0], 1), round(stop[1], 1))
        if key not in dir_cache:
            dir_cache[key] = lane_direction(poly.get(ls.lane), stop)
        d = dir_cache[key]
        if d is None:
            continue
        head = math.atan2(d[1], d[0])
        lanes.append((ls.lane, ls.state, stop, head, lane_features(stop, d, head, P, t)))

    out = []
    for i, (lid, state, stop, head, f) in enumerate(lanes):
        # Context from OTHER lanes' behavior only (never their labels: that leaks).
        ctx = dict(conf_n_crs=0, conf_n_app_stopped=0, conf_max_spd=0.0,
                   opp_n_crs=0, par_n_crs=0, par_n_app_stopped=0)
        for j, (lj, _, sj, hj, fj) in enumerate(lanes):
            if j == i or lj == lid:
                continue
            if math.hypot(sj[0] - stop[0], sj[1] - stop[1]) > CONTEXT_RADIUS:
                continue
            ang = abs(wrap(hj - head))
            if math.radians(60) < ang < math.radians(120):      # crossing traffic
                ctx["conf_n_crs"] += fj["n_crs"]
                ctx["conf_n_app_stopped"] += fj["n_app_stopped"]
                if fj["n_crs"]:
                    ctx["conf_max_spd"] = max(ctx["conf_max_spd"], fj["crs_mean_spd"])
            elif ang > math.radians(150):                         # opposing traffic
                ctx["opp_n_crs"] += fj["n_crs"]
            elif ang < math.radians(20):                          # same-direction neighbors
                ctx["par_n_crs"] += fj["n_crs"]
                ctx["par_n_app_stopped"] += fj["n_app_stopped"]
        out.append((lid, state, {**f, **ctx}))
    return out


def process_scenario(sc):
    S = scenario_context(sc)
    if S is None:
        return [], 0
    rows = []
    for t in range(LOOKBACK, S["T"], STEP):
        for lid, state, feats in step_features(sc, S, t):
            if state in LABEL_MAP:
                rows.append({"scenario_id": sc.scenario_id, "t": t, "lane_id": lid,
                             "raw_state": state, "label": LABEL_MAP[state], **feats})
    return rows, S["T"]


def shard_index(path):
    m = re.search(r"-(\d{5})-of-\d{5}", path)
    return int(m.group(1)) if m else -1


def process_shard(job):
    path, out_dir, max_sc = job
    out = os.path.join(out_dir, os.path.basename(path) + ".parquet")
    if os.path.exists(out):
        return path, "skipped", 0, 0, []
    t0, rows, n_sc, Ts = time.time(), [], 0, []
    for raw in read_tfrecord(path):
        sc = scenario_pb2.Scenario.FromString(raw)
        r, T = process_scenario(sc)
        rows.extend(r)
        Ts.append(T)
        n_sc += 1
        if max_sc and n_sc >= max_sc:
            break
    df = pd.DataFrame(rows)
    df["shard"] = shard_index(path)
    df.to_parquet(out + ".tmp", index=False)
    os.replace(out + ".tmp", out)
    return path, f"{time.time() - t0:.0f}s", n_sc, len(df), Ts


def parse_shards(spec):
    out = set()
    for part in spec.split(","):
        if "-" in part:
            a, b = map(int, part.split("-"))
            out.update(range(a, b + 1))
        else:
            out.add(int(part))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--shards", default="0", help='e.g. "0", "0-29", "0-19,140-149"')
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--max-scenarios", type=int, default=0, help="per shard, for debugging")
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    want = parse_shards(a.shards)
    files = sorted(p for p in glob.glob(os.path.join(a.data, "*tfrecord*"))
                   if shard_index(p) in want)
    print(f"{len(files)} shards -> {a.out}")
    jobs = [(p, a.out, a.max_scenarios) for p in files]

    with Pool(a.workers) as pool:
        for path, took, n_sc, n_rows, Ts in pool.imap_unordered(process_shard, jobs):
            extra = f" | timesteps/scenario: {min(Ts)}-{max(Ts)}" if Ts else ""
            print(f"{os.path.basename(path)}: {took}, {n_sc} scenarios, {n_rows} rows{extra}",
                  flush=True)


if __name__ == "__main__":
    main()
