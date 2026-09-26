#!/usr/bin/env python3
"""
Run the trained model on EVERY step of one scenario and add its guesses to scene.json.

  python predict_scene.py --shard D:/waymo_data/uncompressed/scenario/training/training.tfrecord-00040-of-01000 \
      --index 4 --model model.txt --scene scene.json --thr 0.8

Make the scene first with approaches.py --scene (same shard + index).
Adds scene["model"]; prints a model-vs-truth check for the scenario.
"""
import argparse
import json
from collections import defaultdict

import lightgbm as lgb
import numpy as np

from approaches import (APPROACHES, combine_lane_predictions, ego_approach, ego_lane,
                        group_intersections, lane_geometry, lane_truth_series, load_scenario,
                        true_timeline)
from extract_features import LOOKBACK, scenario_context, step_features


def has_evidence(f):
    # Must match no_evidence() in train.py
    return (f["n_app"] + f["n_crs"] + f["conf_n_crs"] + f["opp_n_crs"] + f["par_n_crs"]) > 0


def load_model(path):
    booster = lgb.Booster(model_file=path)
    n_cls = booster.num_model_per_iteration()
    classes = ["GO", "STOP"] if n_cls == 2 else ["CAUTION", "GO", "STOP"]  # train.py sorts labels
    return {"booster": booster, "names": booster.feature_name(), "classes": classes}


def predict_scenario(sc, inter, model, thr):
    """Model guesses for every step. Returns (approach_out, lane_out), one entry per step:
    approach_out[t][dir] = [phase, confidence, committed]; lane_out[t][lane_id] = [phase, confidence]."""
    lane_to_appr = {l: d for d, ls in inter["approaches"].items() for l in ls}
    names, classes = model["names"], model["classes"]
    S = scenario_context(sc)
    if S is None:
        T = len(sc.dynamic_map_states)
        empty = {d: (["NONE", 0.0, False] if d not in inter["approaches"] else ["UNKNOWN", 0.0, False])
                 for d in APPROACHES}
        return [dict(empty) for _ in range(T)], [{} for _ in range(T)]
    T = S["T"]
    keys, X = [], []
    for t in range(LOOKBACK, T):
        for lid, _, f in step_features(sc, S, t):
            if lid in lane_to_appr and has_evidence(f):
                keys.append((t, lid))
                X.append([f[n] for n in names])
    probs = model["booster"].predict(np.array(X, dtype=float)) if X else np.zeros((0, len(classes)))

    lane_probs = defaultdict(dict)
    for (t, lid), p in zip(keys, probs):
        lane_probs[t][lid] = {c: float(p[k]) for k, c in enumerate(classes)}

    lane_out, appr_out = [], []
    for t in range(T):
        lp = lane_probs.get(t, {})
        lane_out.append({str(l): [max(p, key=p.get), round(max(p.values()), 3)] for l, p in lp.items()})
        combined = combine_lane_predictions(lp, inter)
        step = {}
        for d in APPROACHES:
            if d not in inter["approaches"]:
                step[d] = ["NONE", 0.0, False]
            else:
                phase, conf = combined[d]
                step[d] = [phase, conf, phase != "UNKNOWN" and conf >= thr]
        appr_out.append(step)
    return appr_out, lane_out


def evaluate(appr_out, truth):
    """Model vs truth over one scenario, per (step, direction) with a known true light.
    early_s = longest time the model correctly committed to a direction's light BEFORE
    Waymo's own car could see it (truth still UNKNOWN)."""
    T = min(len(appr_out), len(truth))
    judged = committed = correct = dangerous = 0
    for t in range(T):
        for d in APPROACHES:
            tr = truth[t][d]
            if tr not in ("STOP", "GO", "CAUTION"):
                continue
            judged += 1
            phase, _, ok = appr_out[t][d]
            if ok:
                committed += 1
                correct += phase == tr
                dangerous += (phase == "GO" and tr == "STOP")
    early = 0.0
    for d in APPROACHES:
        first = next((t for t in range(T) if truth[t][d] in ("STOP", "GO", "CAUTION")), None)
        if not first:
            continue
        target, start = truth[first][d], None
        for t in range(first):
            phase, _, ok = appr_out[t][d]
            if ok and phase == target:
                start = t if start is None else start
            elif ok:               # committed to something else: reset
                start = None
        if start is not None:
            early = max(early, (first - start) / 10)
    return {"judged": judged, "committed": committed, "correct": correct,
            "dangerous": dangerous, "early_s": early,
            "coverage": committed / judged if judged else 0.0,
            "accuracy": correct / committed if committed else float("nan")}


KNOWN = ("STOP", "GO", "CAUTION")


def ego_series(lane_out, lane_id, thr):
    """The model's guess for the Waymo car's OWN lane at every step: [phase, conf, committed]."""
    out = []
    for step in lane_out:
        p = step.get(str(lane_id))
        out.append([p[0], p[1], p[1] >= thr] if p else ["UNKNOWN", 0.0, False])
    return out


def evaluate_series(pred, truth):
    """Score one light over time. pred[t] = [phase, conf, committed], truth[t] = state.
    fallback_s = longest stretch where the model HAD been confident on this light, then
    backed off while the true light was known (= a stage-4 all-way-stop moment)."""
    T = min(len(pred), len(truth))
    judged = committed = correct = dangerous = 0
    best = run = 0
    seen_commit = False
    for t in range(T):
        phase, _, ok = pred[t]
        known = truth[t] in KNOWN
        if known:
            judged += 1
            if ok:
                committed += 1
                correct += phase == truth[t]
                dangerous += (phase == "GO" and truth[t] == "STOP")
        if ok:
            seen_commit, run = True, 0
        elif known and seen_commit and t >= LOOKBACK:
            run += 1
            best = max(best, run)
        else:
            run = 0
    return {"judged": judged, "committed": committed, "correct": correct,
            "dangerous": dangerous, "fallback_s": best / 10,
            "coverage": committed / judged if judged else 0.0,
            "accuracy": correct / committed if committed else float("nan")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", required=True)
    ap.add_argument("--index", type=int, default=0)
    ap.add_argument("--scenario-id", default=None)
    ap.add_argument("--inter", type=int, default=0)
    ap.add_argument("--model", default="model.txt")
    ap.add_argument("--scene", default="scene.json")
    ap.add_argument("--thr", type=float, default=0.8)
    a = ap.parse_args()

    sc = load_scenario(a.shard, a.index, a.scenario_id)
    inter = group_intersections(lane_geometry(sc))[a.inter]
    model = load_model(a.model)
    classes = model["classes"]
    appr_out, lane_out = predict_scenario(sc, inter, model, a.thr)
    T = len(appr_out)

    merge = len(classes) == 2
    truth = true_timeline(sc, inter, merge_caution=merge)
    ev = evaluate(appr_out, truth)

    geom = lane_geometry(sc)
    el = ego_lane(sc, inter, geom)
    ego_pred = ego_series(lane_out, el, a.thr) if el is not None else None
    ego_truth = lane_truth_series(sc, el, merge) if el is not None else None
    print(f"scenario {sc.scenario_id}, intersection #{inter['id']}, threshold {a.thr}")
    if ev["judged"]:
        acc = f"{ev['accuracy']:.1%}" if ev["committed"] else "n/a"
        print(f"  direction-steps with a known true light: {ev['judged']}")
        print(f"  model committed on {ev['coverage']:.1%}, accuracy when committed {acc}, "
              f"dangerous GO-on-red: {ev['dangerous']}")
        if ev["early_s"]:
            print(f"  read a light correctly {ev['early_s']:.1f}s before Waymo's car could see it")
    if el is None:
        print("  Waymo car isn't approaching one of this intersection's lights (no EGO column)")
    else:
        ee = evaluate_series(ego_pred, ego_truth)
        acc = f"{ee['accuracy']:.1%}" if ee["committed"] else "n/a"
        print(f"  WAYMO CAR'S OWN LIGHT ({ego_approach(sc, inter, geom)}, lane {el}): "
              f"committed on {ee['coverage']:.1%}, accuracy {acc}, "
              f"dangerous {ee['dangerous']}, longest all-way-stop fallback {ee['fallback_s']:.1f}s")

    print("\n  every 0.5 s  (model phase / confidence, * = committed; truth in brackets)")
    for t in range(0, T, 5):
        cells = []
        if el is not None:
            phase, conf, ok = ego_pred[t]
            cells.append(f"EGO={phase[:4]}/{conf:.2f}{'*' if ok else ' '}[{ego_truth[t][:4]}] |")
        for d in APPROACHES:
            phase, conf, ok = appr_out[t][d]
            if phase == "NONE":
                continue
            cells.append(f"{d}={phase[:4]}/{conf:.2f}{'*' if ok else ' '}[{truth[t][d][:4]}]")
        print(f"  t={t / 10:4.1f}s  " + "  ".join(cells))

    with open(a.scene) as fh:
        scene = json.load(fh)
    if scene.get("scenario_id") != sc.scenario_id:
        raise SystemExit(f"{a.scene} is for scenario {scene.get('scenario_id')}, not {sc.scenario_id}. "
                         "Re-export it with approaches.py --scene using the same shard/index.")
    scene["model"] = {
        "threshold": a.thr,
        "classes": classes,
        "warmup_steps": LOOKBACK,
        "format": "approach: per step {dir: [phase, confidence, committed]}; "
                  "lane: per step {lane_id: [phase, confidence]} for lanes with evidence. "
                  "UNKNOWN = no nearby traffic (or first 1 s warm-up); NONE = no lights that way. "
                  "ego: per step [phase, confidence, committed] for the Waymo car's own lane "
                  "(null if it isn't approaching a light) -> use this for the big 'your light' panel.",
        "approach": appr_out,
        "lane": lane_out,
        "ego_lane": el,
        "ego": ego_pred,   # per step [phase, confidence, committed] for the Waymo car's own lane
    }
    with open(a.scene, "w") as fh:
        json.dump(scene, fh, separators=(",", ":"))
    print(f"\nwrote model predictions into {a.scene}")


if __name__ == "__main__":
    main()
