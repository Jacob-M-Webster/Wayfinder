#!/usr/bin/env python3
"""
Rank scenarios in a shard by how good they'd be as a DEMO scene.

  python find_demo.py --shard <path> --model model.txt                  # overall (Scene A)
  python find_demo.py --shard <path> --model model.txt --rank fallback  # Scene B: model backs off
  python find_demo.py --shard <path> --model model.txt --rank busy      # Scene C: lots going on
  python find_demo.py --shard <path> --model model.txt --rank arc       # car's own light changes mid-scene
                                                                        # with lead-up before and driving after
                                                                        # (best with training_20s)

Columns:
  len       recording length
  ego       direction of the Waymo car's lane ("-" = not approaching a light)
  changes   real light changes (UNKNOWN gaps ignored)
  known     % of the time the true light is known (all directions)
  egoknown  % of the time the Waymo car's OWN lane's light is known
  cars      vehicles within 40 m of the intersection
  --- with --model ---
  cover     % of known moments where the model commits
  acc       accuracy when it commits
  danger    times it said GO on a red (want 0)
  early     seconds it read a light correctly BEFORE Waymo's car could see it
  egocover  % of the time the model commits on the Waymo car's OWN lane
  egoacc    accuracy on the Waymo car's own lane when it commits
  fallback  longest stretch where the model HAD been confident on the Waymo car's OWN
            lane, then backed off while that light was known (-> stage 4, all-way stop).
            0 if the car isn't approaching a light.
  change    when the car's OWN light first changes (seconds; "-" = never)
  margin    seconds of scene on the shorter side of that change (before vs after)
  catch     seconds from that change until the model commits to the new phase ("-" = never)

Use the printed --index with approaches.py --scene / predict_scene.py.
"""
import argparse
import math

from waymo_open_dataset.protos import scenario_pb2

from approaches import (APPROACHES, ego_approach, ego_lane, group_intersections, lane_geometry,
                        lane_truth_series, true_timeline)
from extract_features import LOOKBACK, read_tfrecord

KNOWN = ("STOP", "GO", "CAUTION")


def truth_stats(tl, inter):
    dirs = [d for d in APPROACHES if d in inter["approaches"]]
    cells = [(t, d) for t in range(len(tl)) for d in dirs]
    known = sum(tl[t][d] in KNOWN for t, d in cells) / len(cells) if cells else 0.0
    changes = 0
    for d in dirs:
        last = None
        for step in tl:
            s = step[d]
            if s not in KNOWN:
                continue
            if last is not None and s != last:
                changes += 1
            last = s
    return changes, known


def cars_near(sc, center, r=40.0):
    cx, cy = center
    return sum(1 for tr in sc.tracks if tr.object_type == 1 and any(
        s.valid and math.hypot(s.center_x - cx, s.center_y - cy) < r for s in tr.states))


def ego_change(ego_truth):
    """First step where the car's own light changes between known states, or None."""
    last = None
    for t, st in enumerate(ego_truth):
        if st not in KNOWN:
            continue
        if last is not None and st != last:
            return t
        last = st
    return None


def catch_time(ego_pred, ego_truth, t0):
    """Seconds after step t0 until the model commits to the new phase (None if never)."""
    new = ego_truth[t0]
    for t in range(t0, min(len(ego_pred), len(ego_truth))):
        phase, _, ok = ego_pred[t]
        if ok and phase == new:
            return (t - t0) / 10
    return None


def score(r, rank, has_model):
    danger_pen = (r.get("dangerous", 0) + r.get("ego_danger", 0)) * 30
    if rank == "fallback":
        if not has_model:
            raise SystemExit("--rank fallback needs --model")
        return r["fallback_s"] * 10 + r["ego_known"] * 10 + r["ego_cover"] * 5 - danger_pen
    if rank == "arc":
        if not has_model:
            raise SystemExit("--rank arc needs --model")
        if r["change_s"] is None:
            return -1e9
        caught = r["catch_s"] is not None
        return (min(r["margin_s"], 8) * 5 + (20 if caught else 0)
                - (r["catch_s"] or 0) * 3 + r["ego_cover"] * 10 - danger_pen)
    if rank == "busy":
        return r["changes"] * 10 + min(r["cars"], 60) / 2 + r["known"] * 10 - danger_pen
    s = r["changes"] * 10 + r["known"] * 20 + min(r["cars"], 40) / 4 + r["ego_known"] * 10
    if has_model:
        acc = 0.0 if math.isnan(r["accuracy"]) else r["accuracy"]
        s += r["coverage"] * 20 + acc * 10 + r["early_s"] * 5 - danger_pen
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", required=True)
    ap.add_argument("--max-scenarios", type=int, default=200, help="how many to scan")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--model", default=None, help="model.txt to also score the model")
    ap.add_argument("--thr", type=float, default=0.8)
    ap.add_argument("--rank", choices=["overall", "fallback", "busy", "arc"], default="overall")
    ap.add_argument("--min-changes", type=int, default=1,
                    help="skip scenarios with fewer real light changes (0 keeps all)")
    a = ap.parse_args()

    model = None
    if a.model:
        from predict_scene import (ego_series, evaluate, evaluate_series, load_model,
                                   predict_scenario)
        model = load_model(a.model)
    merge = bool(model) and len(model["classes"]) == 2

    results = []
    for i, raw in enumerate(read_tfrecord(a.shard)):
        if i >= a.max_scenarios:
            break
        if (i + 1) % 50 == 0:
            print(f"  scanned {i + 1}...", flush=True)
        sc = scenario_pb2.Scenario.FromString(raw)
        geom = lane_geometry(sc)
        inters = group_intersections(geom)
        if not inters:
            continue
        inter = inters[0]
        tl = true_timeline(sc, inter, merge_caution=merge)
        changes, known = truth_stats(tl, inter)
        if changes < a.min_changes:
            continue
        el = ego_lane(sc, inter, geom)
        ego = ego_approach(sc, inter, geom)
        ego_truth = lane_truth_series(sc, el, merge) if el is not None else None
        ego_known = sum(s in KNOWN for s in ego_truth) / len(ego_truth) if el is not None else 0.0
        r = {"index": i, "id": sc.scenario_id, "secs": len(tl) / 10, "ego": ego or "-",
             "changes": changes, "known": known, "ego_known": ego_known,
             "cars": cars_near(sc, inter["center"])}
        t0 = ego_change(ego_truth) if el is not None else None
        r["change_s"] = t0 / 10 if t0 is not None else None
        r["margin_s"] = min(t0, len(ego_truth) - t0) / 10 if t0 is not None else 0.0
        r["catch_s"] = None
        if model:
            appr, lane_out = predict_scenario(sc, inter, model, a.thr)
            r.update(evaluate(appr, tl))
            if el is not None:
                ee = evaluate_series(ego_series(lane_out, el, a.thr), ego_truth)
                r.update(ego_cover=ee["coverage"], ego_acc=ee["accuracy"],
                         ego_danger=ee["dangerous"], fallback_s=ee["fallback_s"])
                if t0 is not None:
                    r["catch_s"] = catch_time(ego_series(lane_out, el, a.thr), ego_truth, t0)
            else:
                r.update(ego_cover=0.0, ego_acc=float("nan"), ego_danger=0, fallback_s=0.0)
        r["score"] = score(r, a.rank, bool(model))
        results.append(r)

    results.sort(key=lambda r: r["score"], reverse=True)
    print(f"\nranked by '{a.rank}': top {min(a.top, len(results))} of {len(results)} scenarios\n")
    head = (f"  {'--index':>7}  {'scenario':<18}{'len':>5}{'ego':>5}{'changes':>8}"
            f"{'known':>7}{'egoknown':>9}{'cars':>6}{'change':>8}{'margin':>8}")
    if model:
        head += (f"{'cover':>7}{'acc':>7}{'danger':>7}{'early':>7}"
                 f"{'egocover':>9}{'egoacc':>7}{'fallback':>9}{'catch':>7}")
    print(head)
    for r in results[:a.top]:
        line = (f"  {r['index']:>7}  {r['id']:<18}{r['secs']:>4.0f}s{r['ego']:>5}{r['changes']:>8}"
                f"{r['known']:>7.0%}{r['ego_known']:>9.0%}{r['cars']:>6}"
                + (f"{r['change_s']:>7.1f}s{r['margin_s']:>7.1f}s" if r["change_s"] is not None
                   else f"{'-':>8}{'-':>8}"))
        if model:
            acc = "n/a" if math.isnan(r["accuracy"]) else f"{r['accuracy']:.0%}"
            eacc = "n/a" if math.isnan(r["ego_acc"]) else f"{r['ego_acc']:.0%}"
            danger = r["dangerous"] + r["ego_danger"]
            line += (f"{r['coverage']:>7.0%}{acc:>7}{danger:>7}{r['early_s']:>6.1f}s"
                     f"{r['ego_cover']:>9.0%}{eacc:>7}{r['fallback_s']:>8.1f}s"
                     + (f"{r['catch_s']:>6.1f}s" if r["catch_s"] is not None else f"{'-':>7}"))
        print(line)


if __name__ == "__main__":
    main()
