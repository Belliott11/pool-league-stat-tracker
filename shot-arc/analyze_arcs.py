"""Exploratory analysis of the accepted shot arcs joined to the shot log. Writes shot_arcs_features.csv
(one row per arc with derived shape features and the logged context) and prints the findings.
Pixel features are only comparable within one recording (camera differs), so cross-recording
statistics use within-recording ranks or ratios."""
import csv
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy import stats

import run_pipeline as rp
from select_sample_shots import DUNK_SOURCE, GAME_4K_SOURCE, find_clean_candidates

HERE = Path(__file__).parent
H = 2160
FPS = 30


def load_rows():
    state = json.loads(DUNK_SOURCE.read_text(encoding="utf-8"))
    events = {}
    for g in state["games"]:
        for e in g["scoringEvents"]:
            if e.get("videoTime") is not None:
                events[(g["id"], round(e["videoTime"], 3))] = e
    cands = {rp.safe_shot_key(c): c for c in find_clean_candidates()}
    # Arcs the PC's fine-tuned detector added, accepted after checking each by eye (ft_full/review.json).
    # Shot details always come from the current shot list. A key is left out if the log still has two
    # shots at that exact video time: an arc there cannot be tied to one of them.
    ft = HERE / "ft_full"
    review = json.loads((ft / "review.json").read_text()) if (ft / "review.json").exists() else {"accepted_new": []}
    same_time = set()
    for g in json.loads(DUNK_SOURCE.read_text(encoding="utf-8"))["games"]:
        seen = {}
        for e in g["scoringEvents"]:
            if e.get("points") in (2, 3) and e.get("videoTime") is not None:
                t = f"{e['videoTime']:.3f}".replace(".", "_")
                seen[t] = seen.get(t, 0) + 1
        same_time |= {f"{g['id']}_{t}" for t, n in seen.items() if n > 1}
    sources = [(HERE, r, cands.get(r["shot_key"])) for r in json.loads((HERE / "pipeline_results_refit.json").read_text())]
    seen_keys = {r["shot_key"] for _, r, _ in sources if r["fit"].get("usable")}
    for folder in (ft, HERE / "ft_full_v3"):
        rev = json.loads((folder / "review.json").read_text()) if (folder / "review.json").exists() else {"accepted_new": []}
        accepted = set(rev["accepted_new"])
        if not accepted:
            continue
        for r in json.loads((folder / "pipeline_results_refit.json").read_text()):
            if r["shot_key"][5:] in accepted and r["shot_key"] not in seen_keys:
                sources.append((folder, r, cands.get(r["shot_key"])))
                seen_keys.add(r["shot_key"])
    # Arcs traced by hand with arc-trace.html (three clicks per shot: release, highest point, hoop).
    # The parabola through the three points gives the same measurements the tracker's fit does.
    hand_file = HERE / "hand_traces.json"
    if hand_file.exists():
        by_game = defaultdict(list)
        for g in json.loads(DUNK_SOURCE.read_text(encoding="utf-8"))["games"]:
            by_game[g["id"]] = sorted(e["videoTime"] for e in g["scoringEvents"] if e.get("videoTime") is not None and e.get("points") in (1, 2, 3))
        have = {r["shot_key"] for _, r, _ in sources if r["fit"].get("usable")}
        for tr in json.loads(hand_file.read_text(encoding="utf-8")):
            key = "real_" + tr["key"]
            c = cands.get(key)
            if tr.get("skipped") or len(tr.get("points", [])) != 3 or c is None or key in have:
                continue
            t = [p["f"] / FPS for p in tr["points"]]
            py = np.polyfit(t, [H - p["y"] for p in tr["points"]], 2)
            if py[0] >= 0 or not 0.3 <= t[2] - t[0] <= 2.5:
                continue
            tp = min(max(-py[1] / (2 * py[0]) - t[0], 0.0), t[2] - t[0])
            start = c["video_time_abs"] - 1.0 + t[0]
            end = c["video_time_abs"] - 1.0 + t[2]
            gaps = [min(abs(o - start), abs(o - end)) for o in by_game[c["game_id"]]
                    if abs(o - c["video_time_abs"]) > 0.01 and start - 1 <= o <= end + 1]
            near = min(gaps) if gaps else None
            fit = {"usable": True, "time_to_peak_s": tp, "frame_range": None,
                   "attribution": f"ambiguous: {near:.1f}s" if near is not None and near < 1.0 else "clear"}
            sources.append(("hand", {"shot_key": key, "fit": fit, "pts": [(t[i], tr["points"][i]["x"], H - tr["points"][i]["y"]) for i in range(3)]}, c))
    rows = []
    for src, r, c in sources:
        f = r["fit"]
        if not f.get("usable") or c is None or r["shot_key"][5:] in same_time:
            continue
        key = r["shot_key"]
        if src == "hand":
            pts = r["pts"]
        else:
            tracked = json.loads((src / f"{key}-tracked.json").read_text(encoding="utf-8"))["frames"]
            lo, hi = f["frame_range"]
            pts = [(i / FPS, x["x"], H - x["y"]) for i, x in enumerate(tracked) if "x" in x and lo <= i + 1 <= hi]
        t = np.array([p[0] for p in pts]); xs = np.array([p[1] for p in pts]); ys = np.array([p[2] for p in pts])
        py, px = np.polyfit(t, ys, 2), np.polyfit(t, xs, 1)
        tt = np.linspace(t.min(), t.max(), 100)
        ax, ay = np.polyval(px, tt), np.polyval(py, tt)
        span = math.hypot(ax[-1] - ax[0], ay[-1] - ay[0])
        # Height of the arc above the straight line between its two ends, perpendicular-free
        # (vertical gap), the same idea as an arc's "rise".
        chord = ay[0] + (ay[-1] - ay[0]) * (ax - ax[0]) / (ax[-1] - ax[0] if ax[-1] != ax[0] else 1)
        arch = float(np.max(ay - chord))
        dur = float(t.max() - t.min())
        ev = events.get((key.split("_")[1], round(c["video_time_abs"], 3)), {})
        loc = c["shot_location"]
        rows.append({
            "key": key[5:], "recording": GAME_4K_SOURCE[c["game_id"]].name, "shooter": c["shooter"],
            "points": c["points"], "made": int(c["made"]),
            "dist": math.hypot(loc["x"] - 50, loc["y"]),
            "contested": int(bool(ev.get("defenderIds"))),
            "flight_s": dur, "apex_frac": float(f["time_to_peak_s"]) / dur if dur else float("nan"),
            "span_px": span, "arch_px": arch, "arch_ratio": arch / span if span else float("nan"),
            "speed_px_s": span / dur if dur else float("nan"),
            "attribution": f.get("attribution", "clear").split(":")[0],
            "source": "hand" if src == "hand" else ("pc" if src != HERE else "laptop"),
        })
    return rows


def within_recording_z(rows, field):
    by = defaultdict(list)
    for r in rows:
        by[r["recording"]].append(r[field])
    out = []
    for r in rows:
        v = by[r["recording"]]
        sd = np.std(v)
        out.append((r[field] - np.mean(v)) / sd if len(v) >= 3 and sd > 0 else float("nan"))
    return out


def mwu(a, b):
    a, b = np.array(a), np.array(b)
    a, b = a[~np.isnan(a)], b[~np.isnan(b)]
    u, p = stats.mannwhitneyu(a, b, alternative="two-sided")
    rbc = 1 - 2 * u / (len(a) * len(b))  # rank-biserial: >0 means a tends to be larger
    return len(a), len(b), float(np.median(a)), float(np.median(b)), float(rbc), float(p)


def boot_ci(x, y, n=4000, seed=1):
    rng = np.random.default_rng(seed)
    x, y = np.array(x), np.array(y)
    d = [np.median(rng.choice(x, len(x))) - np.median(rng.choice(y, len(y))) for _ in range(n)]
    return float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))


def main():
    rows = load_rows()
    for f in ("flight_s", "arch_ratio", "apex_frac", "speed_px_s", "span_px"):
        for r, z in zip(rows, within_recording_z(rows, f)):
            r[f + "_z"] = z
    with open(HERE / "shot_arcs_features.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)

    print(f"{len(rows)} arcs: {sum(r['made'] for r in rows)} makes, {sum(1 - r['made'] for r in rows)} misses; "
          f"{sum(r['points'] == 3 for r in rows)} threes, {sum(r['points'] == 2 for r in rows)} twos")
    print("per recording:", {k: sum(1 for r in rows if r['recording'] == k) for k in sorted({r['recording'] for r in rows})})
    print("per shooter:", dict(sorted(((s, sum(1 for r in rows if r['shooter'] == s)) for s in {r['shooter'] for r in rows}), key=lambda kv: -kv[1])))

    print("\n1) SANITY CHECK: does the arc track the logged distance? (Spearman, within-recording z where noted)")
    d = [r["dist"] for r in rows]
    for f in ("flight_s", "span_px", "arch_px"):
        rho, p = stats.spearmanr(d, [r[f] for r in rows]) if f == "flight_s" else stats.spearmanr(
            [r["dist"] for r in rows if not math.isnan(r.get(f + "_z", 0))], [r[f + "_z"] if f + "_z" in r else r[f] for r in rows if not math.isnan(r.get(f + "_z", 0))])
        print(f"   logged distance vs {f:9}: rho={rho:+.2f} (p={p:.3f})")
    ok = [r for r in rows if not math.isnan(r["span_px_z"])]
    rho, p = stats.spearmanr([r["dist"] for r in ok], [r["span_px_z"] for r in ok]); print(f"   logged distance vs span (within-recording z): rho={rho:+.2f} (p={p:.3f}, n={len(ok)})")
    two = [r["flight_s"] for r in rows if r["points"] == 2]; three = [r["flight_s"] for r in rows if r["points"] == 3]
    print(f"   flight time, 2-pointers median {np.median(two):.2f}s (n={len(two)}) vs 3-pointers {np.median(three):.2f}s (n={len(three)})")

    print("\n2) MAKES vs MISSES (median make | median miss, rank-biserial effect: + means makes are larger; p from Mann-Whitney)")
    made = [r for r in rows if r["made"]]; miss = [r for r in rows if not r["made"]]
    for f, label in (("flight_s", "flight time (s)"), ("apex_frac_z", "apex timing, within-recording z"), ("arch_ratio_z", "arc steepness, within-recording z"),
                     ("speed_px_s_z", "speed, within-recording z"), ("span_px_z", "distance covered, within-recording z"), ("dist", "logged distance")):
        n1, n2, m1, m2, rbc, p = mwu([r[f] for r in made], [r[f] for r in miss])
        lo, hi = boot_ci([r[f] for r in made if not math.isnan(r[f])], [r[f] for r in miss if not math.isnan(r[f])])
        print(f"   {label:38} {m1:+.2f} | {m2:+.2f}  effect {rbc:+.2f}  p={p:.2f}  95% CI of median gap [{lo:+.2f}, {hi:+.2f}]  (n={n1}+{n2})")

    print("\n3) MAKE RATE (small samples, descriptive only)")
    for label, sel in (("all arcs", rows), ("2-pointers", [r for r in rows if r["points"] == 2]), ("3-pointers", [r for r in rows if r["points"] == 3]),
                       ("contested", [r for r in rows if r["contested"]]), ("uncontested", [r for r in rows if not r["contested"]])):
        print(f"   {label:12} {sum(r['made'] for r in sel)}/{len(sel)}")
    print("   by shooter (arcs only):", {s: f"{sum(r['made'] for r in rows if r['shooter'] == s)}/{sum(1 for r in rows if r['shooter'] == s)}" for s in sorted({r['shooter'] for r in rows})})

    print("\n4) ARC SHAPE BY SHOOTER (within-recording z, median; shooters with 4+ arcs)")
    for s in sorted({r["shooter"] for r in rows}):
        sel = [r for r in rows if r["shooter"] == s]
        if len(sel) >= 4:
            def med(f):
                v = [r[f] for r in sel if not math.isnan(r[f])]
                return f"{np.median(v):+.2f}" if v else "n/a"
            print(f"   {s:9} n={len(sel):2}  flight {np.median([r['flight_s'] for r in sel]):.2f}s  steepness z {med('arch_ratio_z')}  apex z {med('apex_frac_z')}  speed z {med('speed_px_s_z')}")


if __name__ == "__main__":
    main()
