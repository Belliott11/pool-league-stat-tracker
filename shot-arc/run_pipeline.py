"""
The real, at-scale run: pulls a sample of real clean shots (select_sample_shots.find_clean_candidates,
not the small 10-shot prototype set), extracts frames for each, tracks the ball with
bootstrap_track.track_shot, fits a parabola to whatever got tracked, and writes one combined
results table -- the actual output shape the standalone build plan asked for, joining back to the
shot log by (game, videoTime, shooter, made).

CPU-only YOLO inference means this is slow (roughly 1-2 minutes per shot: a full-frame seed pass
plus a two-directional tracked pass, ~250-350 inferences total). Meant to run in the background
while real hand-labeling (for validating bootstrap_track.py itself, a separate and still-open
question -- see FINDINGS.md) happens in parallel, not as a quick foreground check.

A shot whose tracked fraction falls below MIN_TRACKED_FRACTION gets no arc fit at all rather than
a number built from a mostly-empty trajectory -- same reasoning as MIN_POINTS_FOR_FIT below it.
"""
import argparse
import json
import random
import re
from pathlib import Path

import numpy as np

from extract_frames import extract_shot_frames, write_labeling_manifest
from select_sample_shots import find_clean_candidates
from bootstrap_track import track_shot, FRAMES_ROOT

FPS = 30
MIN_POINTS_FOR_FIT = 8  # higher bar than detect_and_fit.py's 4 -- a tracked trajectory has more
                         # points available to spend, so ask for more before trusting a fit
MIN_TRACKED_FRACTION = 0.35  # below this, too much of the flight is guesswork to fit at all


def fit_arc(tracked, frame_height):
    points = []
    for i, f in enumerate(tracked["frames"]):
        if "x" not in f:
            continue
        t = i / FPS
        y_from_bottom = frame_height - f["y"]
        points.append((t, y_from_bottom))

    n_total = len(tracked["frames"])
    n_tracked = len(points)
    tracked_fraction = n_tracked / n_total if n_total else 0.0

    if n_tracked < MIN_POINTS_FOR_FIT or tracked_fraction < MIN_TRACKED_FRACTION:
        return {
            "usable": False,
            "reason": f"only {n_tracked}/{n_total} frames tracked ({tracked_fraction:.0%})",
            "points_used": n_tracked, "tracked_fraction": round(tracked_fraction, 2),
        }

    t = np.array([p[0] for p in points])
    y = np.array([p[1] for p in points])
    a, b, c = np.polyfit(t, y, 2)
    if a >= 0:
        return {
            "usable": False, "reason": "fit did not open downward",
            "points_used": n_tracked, "tracked_fraction": round(tracked_fraction, 2),
        }
    t_peak = -b / (2 * a)
    peak_height = a * t_peak ** 2 + b * t_peak + c
    return {
        "usable": True,
        "points_used": n_tracked, "tracked_fraction": round(tracked_fraction, 2),
        "peak_height_px": round(peak_height, 1),
        "time_to_peak_s": round(t_peak - t.min(), 3),
        "flight_duration_s": round(t.max() - t.min(), 3),
    }


def safe_shot_key(candidate):
    # Unique per real shot (game + exact timestamp), filesystem-safe.
    raw = f"real_{candidate['game_id']}_{candidate['video_time_abs']:.3f}"
    return re.sub(r"[^a-zA-Z0-9_]+", "_", raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=30, help="max shots to run (default 30)")
    parser.add_argument("--seed", type=int, default=7, help="shuffle seed for which shots get picked")
    args = parser.parse_args()

    candidates = find_clean_candidates()
    print(f"{len(candidates)} eligible clean shots total.")

    random.seed(args.seed)
    random.shuffle(candidates)
    sample = candidates[: args.limit]
    print(f"Running the pipeline on {len(sample)} shots.\n")

    results = []
    for i, cand in enumerate(sample):
        key = safe_shot_key(cand)
        label = f"[{i+1}/{len(sample)}] {cand['shooter']} {'make' if cand['made'] else 'miss'} " \
                f"game={cand['game_id']} t={cand['video_time_local']:.1f}s"
        print(label)
        try:
            _, _, frames = extract_shot_frames(cand["video_file"], cand["video_time_local"], key)
            if not frames:
                print("  no frames extracted, skipping")
                continue
            from PIL import Image
            frame_h = Image.open(frames[0]).size[1]

            tracked = track_shot(key)
            fit = fit_arc(tracked, frame_h)
        except SystemExit as e:
            print(f"  tracking failed: {e}")
            fit = {"usable": False, "reason": str(e)}
        except Exception as e:
            print(f"  ERROR: {e}")
            fit = {"usable": False, "reason": f"error: {e}"}

        results.append({
            "game_id": cand["game_id"], "video_time_abs": cand["video_time_abs"],
            "shooter": cand["shooter"], "made": cand["made"], "points": cand["points"],
            "shot_location": cand["shot_location"], "fit": fit,
        })
        status = "usable" if fit.get("usable") else f"not usable ({fit.get('reason', '?')})"
        print(f"  -> {status}\n")

    out_path = Path(__file__).parent / "pipeline_results.json"
    out_path.write_text(json.dumps(results, indent=2))

    usable = [r for r in results if r["fit"].get("usable")]
    print(f"\n{len(usable)}/{len(results)} shots produced a usable arc fit.")
    print(f"Wrote {out_path}")

    write_labeling_manifest()  # keep the hand-labeling tool's picker in sync with the new frames


if __name__ == "__main__":
    main()
