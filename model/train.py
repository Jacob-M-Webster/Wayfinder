#!/usr/bin/env python3
"""
Rule baseline + LightGBM on extracted features, with abstention and safety metrics.

  python train.py --feats feats --merge-caution --thr 0.8

Split is by SHARD (scenario-disjoint): last --test-frac of processed shards = test.
Saves model.txt and test_preds.parquet (use the latter for the dashboard replay).
"""
import argparse
import glob

import lightgbm as lgb
import numpy as np
import pandas as pd

META = ["scenario_id", "shard", "t", "lane_id", "raw_state", "label"]


def no_evidence(df):
    return (df.n_app + df.n_crs + df.conf_n_crs + df.opp_n_crs + df.par_n_crs) == 0


def rule_baseline(df):
    pred = np.array([None] * len(df), dtype=object)
    stop = ((df.lead_dist < 10) & (df.lead_spd < 0.5)) | (df.conf_n_crs > 0)
    go = (df.n_crs > 0) | (df.par_n_crs > 0)
    pred[stop.values] = "STOP"
    pred[go.values] = "GO"          # own-lane traffic crossing is the strongest signal
    return pred


def report(name, y, pred):
    y, pred = np.asarray(y), np.asarray(pred, dtype=object)
    commit = pred != None  # noqa: E711
    cov = commit.mean()
    acc = (pred[commit] == y[commit]).mean() if commit.any() else float("nan")
    true_stop = commit & (y == "STOP")
    go_when_stop = (pred[true_stop] == "GO").mean() if true_stop.any() else float("nan")
    print(f"{name:<22} coverage {cov:6.1%}  acc(committed) {acc:6.1%}  "
          f"GO-when-STOP {go_when_stop:6.2%}")
    return cov, acc, go_when_stop


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--feats", required=True)
    ap.add_argument("--test-frac", type=float, default=0.2)
    ap.add_argument("--merge-caution", action="store_true", help="fold CAUTION into STOP")
    ap.add_argument("--thr", type=float, default=0.8, help="confidence threshold for final report")
    a = ap.parse_args()

    df = pd.concat([pd.read_parquet(p) for p in glob.glob(f"{a.feats}/*.parquet")],
                   ignore_index=True)
    if a.merge_caution:
        df.loc[df.label == "CAUTION", "label"] = "STOP"
    print(f"{len(df):,} rows, {df.scenario_id.nunique():,} scenarios")
    print(df.label.value_counts(normalize=True).round(3).to_string(), "\n")

    shards = sorted(df.shard.unique())
    n_test = max(1, int(round(len(shards) * a.test_frac)))
    test_shards, rest = set(shards[-n_test:]), shards[:-n_test]
    val_shards = set(rest[-max(1, len(rest) // 10):])
    te = df[df.shard.isin(test_shards)]
    va = df[df.shard.isin(val_shards)]
    tr = df[~df.shard.isin(test_shards | val_shards)]
    print(f"train {len(tr):,} | val {len(va):,} | test {len(te):,} (shards {sorted(test_shards)})\n")

    feats = [c for c in df.columns if c not in META]
    classes = sorted(df.label.unique())
    enc = {c: i for i, c in enumerate(classes)}

    # --- rule baseline ---
    report("rule baseline", te.label, rule_baseline(te))

    # --- LightGBM ---
    params = dict(objective="multiclass", num_class=len(classes), learning_rate=0.05,
                  num_leaves=63, min_data_in_leaf=100, feature_fraction=0.8,
                  bagging_fraction=0.8, bagging_freq=1, verbose=-1)
    dtr = lgb.Dataset(tr[feats], tr.label.map(enc))
    dva = lgb.Dataset(va[feats], va.label.map(enc))
    model = lgb.train(params, dtr, 2000, valid_sets=[dva],
                      callbacks=[lgb.early_stopping(50, verbose=False)])
    print(f"lightgbm best iter: {model.best_iteration}")

    prob = model.predict(te[feats], num_iteration=model.best_iteration)
    maxp, arg = prob.max(1), prob.argmax(1)
    label_pred = np.array(classes, dtype=object)[arg]
    noev = no_evidence(te).values

    report("lgbm (no abstain)", te.label, label_pred)
    print("\nthreshold sweep (evidence rule + confidence):")
    for thr in [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]:
        p = label_pred.copy()
        p[noev | (maxp < thr)] = None
        report(f"  thr={thr:.2f}", te.label, p)

    final = label_pred.copy()
    final[noev | (maxp < a.thr)] = None
    print(f"\nconfusion @ thr={a.thr} (committed only; rows=true, cols=pred):")
    m = final != None  # noqa: E711
    print(pd.crosstab(te.label.values[m], final[m], rownames=["true"], colnames=["pred"]))
    print("\nper-class recall (committed):")
    for c in classes:
        sel = m & (te.label.values == c)
        if sel.any():
            print(f"  {c:<8} {(final[sel] == c).mean():6.1%}  (n={sel.sum():,})")

    imp = pd.Series(model.feature_importance("gain"), index=feats).sort_values(ascending=False)
    print("\ntop features (gain):\n", (imp / imp.sum()).head(12).round(3).to_string())

    model.save_model("model.txt", num_iteration=model.best_iteration)
    out = te[META].copy()
    out["pred"], out["conf"], out["committed"] = label_pred, maxp, m
    for i, c in enumerate(classes):
        out[f"p_{c}"] = prob[:, i]
    out.to_parquet("test_preds.parquet", index=False)
    print("\nsaved model.txt, test_preds.parquet")


if __name__ == "__main__":
    main()
