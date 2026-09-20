"""Re-tracks a sample of shots that previously produced no arc, using the fine-tuned detector and a
minimum confidence, and reports how many now yield a flight that ends at a hoop.

The original tracking files are never overwritten: each new track goes to ft_tracked/ and the
original is restored right after. Frames must already be on disk (they are, from the earlier runs).

Usage:
  python retrack_failed.py --weights adam-balldata/poolvision-ball-finetuned.pt --min-conf 0.5 --limit 30
Then look at the arcs it prints with:  python retrack_failed.py --montage OUT_DIR"""
import argparse
import json
import os
import random
import shutil
from pathlib import Path

HERE = Path(__file__).parent
FT = HERE / "ft_tracked"


def failing_keys(limit, seed):
    import run_pipeline as rp
    from hoops import rim_centers
    from select_sample_shots import find_clean_candidates

    cands = {rp.safe_shot_key(c): c for c in find_clean_candidates()}
    accepted = {r["shot_key"] for r in json.loads((HERE / "pipeline_results_refit.json").read_text()) if r["fit"].get("usable")}
    pool = [k for k, c in cands.items()
            if not c["dunk"] and k not in accepted and (HERE / f"{k}-tracked.json").exists()
            and (HERE / "frames" / k).exists() and (HERE / f"{k}-hoops.json").exists()]
    random.Random(seed).shuffle(pool)
    return pool[:limit]


def retrack(keys):
    import bootstrap_track as bt

    FT.mkdir(exist_ok=True)
    for n, key in enumerate(keys, 1):
        original = HERE / f"{key}-tracked.json"
        backup = FT / f"{key}-original.json"
        shutil.copy2(original, backup)
        print(f"[{n}/{len(keys)}] {key}")
        try:
            bt.track_shot(key)
            shutil.move(str(original), str(FT / f"{key}-tracked.json"))
        except SystemExit as e:  # no detection above the confidence floor anywhere in the clip
            print(f"  no ball found: {e}")
            (FT / f"{key}-tracked.json").write_text(json.dumps({"shotKey": key, "frames": [{"source": "lost"}] * 180}))
        finally:
            shutil.copy2(backup, original)  # always put the original tracking back


def report(keys):
    import run_pipeline as rp
    from hoops import rim_centers

    found = []
    for key in keys:
        path = FT / f"{key}-tracked.json"
        if not path.exists():
            continue
        tracked = json.loads(path.read_text(encoding="utf-8"))
        rims = rim_centers(json.loads((HERE / f"{key}-hoops.json").read_text()))
        n_tracked = sum(1 for f in tracked["frames"] if "x" in f)
        seg = rp.find_flight_segment(tracked, 2160, rims) if rims else None
        print(f"{key[5:]:34} tracked {n_tracked:3}/180  arc: {'FOUND ' + str(seg[:2]) if seg else 'none'}")
        if seg:
            found.append(key)
    print(f"\n{len(found)} of {len(keys)} previously failing shots now produce an arc")
    (FT / "found.json").write_text(json.dumps(found))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights")
    ap.add_argument("--min-conf", type=float, default=0.5)
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--seed", type=int, default=3)
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args()
    keys = failing_keys(args.limit, args.seed)
    if not args.report_only:
        os.environ["BALL_WEIGHTS"] = str(Path(args.weights).resolve())
        os.environ["BALL_MIN_CONF"] = str(args.min_conf)
        retrack(keys)
    report(keys)
