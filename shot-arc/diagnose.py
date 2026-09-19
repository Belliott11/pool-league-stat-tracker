"""Why does a shot get no accepted flight? For every 180-frame tracked shot that isn't a dunk, prints
how much of the clip the tracker followed and which single relaxation of the rules (if any) would
have produced a flight, so the losses can be sorted into "tracker lost the ball" vs "rules too
strict" vs "no flight in the window". Nothing here changes the pipeline's own results."""
import json
from pathlib import Path

import run_pipeline as rp
from hoops import rim_centers
from select_sample_shots import find_clean_candidates

HERE = Path(__file__).parent
H = 2160


def longest_run(frames, max_gap=3):
    idx = [i for i, f in enumerate(frames) if "x" in f]
    best = cur = 1 if idx else 0
    for a, b in zip(idx, idx[1:]):
        cur = cur + 1 if b - a <= max_gap + 1 else 1
        best = max(best, cur)
    return best


def with_settings(fn, **kw):
    saved = {k: getattr(rp, k) for k in kw}
    for k, v in kw.items():
        setattr(rp, k, v)
    try:
        return fn()
    finally:
        for k, v in saved.items():
            setattr(rp, k, v)


def main():
    dunks = {rp.safe_shot_key(c): c["dunk"] for c in find_clean_candidates()}
    rows = []
    for f in sorted(HERE.glob("real_*-tracked.json")):
        key = f.name[: -len("-tracked.json")]
        tr = json.loads(f.read_text(encoding="utf-8"))
        if len(tr["frames"]) != 180 or dunks.get(key):
            continue
        cache = HERE / f"{key}-hoops.json"
        rims = rim_centers(json.loads(cache.read_text())) if cache.exists() else []
        frames = tr["frames"]
        tracked = sum(1 for x in frames if "x" in x)
        base = rp.find_flight_segment(tr, H, rims) if rims else None
        tests = {
            "no_hoop_rule": lambda: rp.find_flight_segment(tr, H, None),
            "end_700px": lambda: with_settings(lambda: rp.find_flight_segment(tr, H, rims), HOOP_END_MAX_PX=700),
            "rms_50": lambda: with_settings(lambda: rp.find_flight_segment(tr, H, rims), MAX_FIT_RMS_PX=50),
            "seg_10f": lambda: with_settings(lambda: rp.find_flight_segment(tr, H, rims), MIN_SEG_FRAMES=10),
            "cover_50": lambda: with_settings(lambda: rp.find_flight_segment(tr, H, rims), MIN_SEG_COVERAGE=0.5),
        }
        fixes = [name for name, fn in tests.items() if base is None and fn() is not None]
        # Where does the best flight-shaped stretch END, ignoring hoops? Near the frame border means
        # the ball left the picture (a hoop out of view) instead of reaching a visible rim.
        edge = ""
        if base is None:
            seg = rp.find_flight_segment(tr, H, None)
            if seg is not None:
                lo, hi = seg[0], seg[1]
                pts = [(x["x"], x["y"]) for i, x in enumerate(frames) if "x" in x and lo <= i + 1 <= hi]
                ex, ey = pts[-1]
                sx, sy = pts[0]
                near = lambda px, py: px < 300 or px > 3840 - 300 or py < 300 or py > H - 300
                edge = "end at frame edge" if near(ex, ey) else ("start at frame edge" if near(sx, sy) else "flight inside frame")
        rows.append({"edge": edge,
            "key": key[5:], "ok": base is not None, "tracked": tracked, "longest_run": longest_run(frames),
            "rims": len(rims), "would_pass_with": fixes,
        })
    print(f"{'shot':34} {'ok':>3} {'tracked/180':>11} {'longest run':>11} {'rims':>4}  would pass if relaxed / where the flight-like stretch ends")
    for r in rows:
        print(f"{r['key']:34} {'yes' if r['ok'] else 'no':>3} {r['tracked']:>11} {r['longest_run']:>11} {r['rims']:>4}  {', '.join(r['would_pass_with'])}  [{r['edge']}]")
    failing = [r for r in rows if not r["ok"]]
    print(f"\n{len(rows)} non-dunk shots, {len(failing)} failing")
    print("  tracker followed under 60 frames overall:", sum(1 for r in failing if r["tracked"] < 60))
    print("  longest unbroken run under 15 frames:", sum(1 for r in failing if r["longest_run"] < 15))
    print("  no rim found:", sum(1 for r in failing if r["rims"] == 0))
    for label in ("end at frame edge", "start at frame edge", "flight inside frame"):
        print(f"  flight-like stretch found without hoop rule, {label}:", sum(1 for r in failing if r["edge"] == label))
    print("  no flight-like stretch at all:", sum(1 for r in failing if r["edge"] == ""))
    for name in ("no_hoop_rule", "end_700px", "rms_50", "seg_10f", "cover_50"):
        print(f"  would pass with {name}:", sum(1 for r in failing if name in r["would_pass_with"]))


if __name__ == "__main__":
    main()
