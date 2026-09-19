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
from hoops import detect_hoops, rim_centers

FPS = 30
MIN_POINTS_FOR_FIT = 8  # higher bar than detect_and_fit.py's 4 -- a tracked trajectory has more
                         # points available to spend, so ask for more before trusting a fit
MIN_TRACKED_FRACTION = 0.35  # below this, too much of the flight is guesswork to fit at all

# A real shot's flight (release to landing) takes well under 2 seconds at this range -- caught at
# scale (see FINDINGS.md's own "flight=3.97s on nearly every 'usable' result" finding): even after
# fixing the tracker's static-lock-on bug, most fits still spanned almost the entire 4-second
# window, because the window itself often contains more than just the shot (a pass, a dribble, a
# second touch) and the tracker correctly follows the real, moving ball through all of it, not
# only during the actual release-to-landing arc. A fit that spans nearly the whole window is very
# unlikely to be measuring one clean flight, whatever its tracked_fraction or "opens downward"
# check say -- reject it explicitly rather than reporting a number nobody should trust.
MAX_PLAUSIBLE_FLIGHT_S = 2.0


STATIC_STEP_PX = 6      # frame-to-frame movement below this counts as "not moving"
STATIC_RUN_FRAMES = 6   # ...and this many in a row means a stuck lock-on, not a ball in flight
MIN_SEG_FRAMES = 15     # shortest window (in frames) worth fitting an arc to (0.5s)
MAX_GAP_FRAMES = 3      # longest run of untracked frames allowed inside a candidate segment
MIN_SEG_COVERAGE = 0.7  # fraction of a segment's frames that must have a tracked position
MAX_FIT_RMS_PX = 25     # residual allowed on both the vertical parabola and the horizontal line
MIN_TRAVEL_PX = 300     # a real flight covers real ground; smaller is jitter
# A shot ends at a hoop and starts away from it; passes, carries and rim scrambles don't. Chosen
# from a visual check of 15 detected arcs (see FINDINGS.md): real shots ended 48-306px from the
# nearest rim and started at least 534px farther away; a pass to a teammate ended 566px away and the
# others 900+px away or started at the hoop. Small sample, so treat the numbers as a first cut.
HOOP_END_MAX_PX = 400
HOOP_START_MARGIN_PX = 400
# A hoop can be out of view (behind the umbrella, past the frame edge). A shot at it then ends by
# leaving the picture: the flight finishes near a frame border and is still moving toward it.
FRAME_W, FRAME_H = 3840, 2160
EDGE_END_PX = 350
EDGE_START_PX = 1000
# The tracker often loses the ball a few frames before the rim (fast, blurry). If the fitted arc,
# carried forward a short way, lands on a rim, the flight still counts as a shot at that rim.
EXTRAP_FRAMES = 15
EXTRAP_END_MAX_PX = 250   # ...and starts well away from that border, so a ball resting at the edge doesn't count


def leaves_frame(start_pt, end_pt, prev_pt):
    vx, vy = end_pt[0] - prev_pt[0], end_pt[1] - prev_pt[1]
    borders = (
        (end_pt[0], -vx, start_pt[0]),                 # left
        (FRAME_W - end_pt[0], vx, FRAME_W - start_pt[0]),  # right
        (end_pt[1], -vy, start_pt[1]),                 # top
        (FRAME_H - end_pt[1], vy, FRAME_H - start_pt[1]),  # bottom
    )
    return any(dist <= EDGE_END_PX and toward > 0 and start_dist >= EDGE_START_PX for dist, toward, start_dist in borders)


def hoop_anchored(start_pt, end_pt, hoops, prev_pt=None):
    if prev_pt is not None and leaves_frame(start_pt, end_pt, prev_pt):
        return True

    def nearest(pt):
        return min(((pt[0] - h[0]) ** 2 + (pt[1] - h[1]) ** 2) ** 0.5 for h in hoops)
    d_end = nearest(end_pt)
    # Measure the start against the same hoop the flight ends at.
    end_hoop = min(hoops, key=lambda h: (end_pt[0] - h[0]) ** 2 + (end_pt[1] - h[1]) ** 2)
    d_start = ((start_pt[0] - end_hoop[0]) ** 2 + (start_pt[1] - end_hoop[1]) ** 2) ** 0.5
    return d_end <= HOOP_END_MAX_PX and d_start >= d_end + HOOP_START_MARGIN_PX


def extrapolates_to_rim(start_pt, t_end, x_fit, y_fit, frame_height, hoops):
    slope, icpt = x_fit
    for step in range(1, EXTRAP_FRAMES + 1):
        u = t_end + step / FPS
        px = slope * u + icpt
        py = frame_height - float(np.polyval(y_fit, u))
        for hx, hy in hoops:
            d = ((px - hx) ** 2 + (py - hy) ** 2) ** 0.5
            d_start = ((start_pt[0] - hx) ** 2 + (start_pt[1] - hy) ** 2) ** 0.5
            if d <= EXTRAP_END_MAX_PX and d_start >= d + HOOP_START_MARGIN_PX:
                return True
    return False


def find_flight_segment(tracked, frame_height, hoops=None):
    """Searches the whole tracked trajectory for the stretch that best looks like one ball flight:
    vertical position a downward parabola, horizontal position roughly a straight line (constant
    speed), apex inside the segment, duration a plausible flight, and not a stuck lock-on. Returns
    (start_frame, end_frame, fit_details) 1-indexed inclusive, or None. Replaces guessing where in
    the extraction window the shot happens."""
    frames = tracked["frames"]
    pts = {i: (f["x"], f["y"]) for i, f in enumerate(frames) if "x" in f}

    # Drop stuck stretches: a run of near-identical positions is a background object, not the ball.
    idx = sorted(pts)
    static = set()
    run = [idx[0]] if idx else []
    for a, b in zip(idx, idx[1:]):
        step = ((pts[b][0] - pts[a][0]) ** 2 + (pts[b][1] - pts[a][1]) ** 2) ** 0.5
        if b - a <= MAX_GAP_FRAMES and step < STATIC_STEP_PX:
            run.append(b)
        else:
            if len(run) >= STATIC_RUN_FRAMES:
                static.update(run)
            run = [b]
    if len(run) >= STATIC_RUN_FRAMES:
        static.update(run)
    pts = {i: p for i, p in pts.items() if i not in static}

    max_len = int(MAX_PLAUSIBLE_FLIGHT_S * FPS)
    keys = sorted(pts)
    best = None
    for si, s in enumerate(keys):
        for e in keys[si:]:
            span = e - s + 1
            if span > max_len:
                break
            if span < MIN_SEG_FRAMES:
                continue
            seg = [k for k in keys if s <= k <= e]
            if len(seg) < MIN_SEG_COVERAGE * span:
                continue
            if any(b - a > MAX_GAP_FRAMES + 1 for a, b in zip(seg, seg[1:])):
                continue
            t = np.array([k / FPS for k in seg])
            x = np.array([pts[k][0] for k in seg])
            y = np.array([frame_height - pts[k][1] for k in seg])
            if abs(x[-1] - x[0]) + abs(y.max() - y.min()) < MIN_TRAVEL_PX:
                continue
            a2, b1, c0 = np.polyfit(t, y, 2)
            if a2 >= 0:
                continue
            t_peak = -b1 / (2 * a2)
            if not (t[0] <= t_peak <= t[-1]):
                continue
            rms_y = float(np.sqrt(np.mean((np.polyval([a2, b1, c0], t) - y) ** 2)))
            slope, icpt = np.polyfit(t, x, 1)
            rms_x = float(np.sqrt(np.mean((slope * t + icpt - x) ** 2)))
            if rms_y > MAX_FIT_RMS_PX or rms_x > MAX_FIT_RMS_PX:
                continue
            if hoops and not (
                hoop_anchored(pts[seg[0]], pts[seg[-1]], hoops, pts[seg[-4]] if len(seg) >= 4 else None)
                or extrapolates_to_rim(pts[seg[0]], t[-1], (slope, icpt), (a2, b1, c0), frame_height, hoops)
            ):
                continue
            score = (len(seg), -(rms_x + rms_y))
            if best is None or score > best[0]:
                best = (score, s + 1, e + 1, {"rms_y_px": round(rms_y, 1), "rms_x_px": round(rms_x, 1)})
    if best is None:
        return None
    return best[1], best[2], best[3]


LABELS_DIR = Path(__file__).parent / "labels"


def load_shot_range(shot_key):
    """Hand-labeled (shotStartFrame, shotEndFrame), 1-indexed inclusive, from the labeling tool's
    export for this shot, or None if it hasn't been labeled (or was marked not a valid shot)."""
    path = LABELS_DIR / f"{shot_key}-labels.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    start, end = data.get("shotStartFrame"), data.get("shotEndFrame")
    if not start or not end or end < start:
        return None
    return start, end


def fit_arc(tracked, frame_height, frame_range=None):
    # frame_range restricts the fit to the human-marked release-to-landing span, sidestepping the
    # fixed extraction window (which usually holds far more than one flight -- see FINDINGS.md).
    points = []
    frames = tracked["frames"]
    if frame_range:
        lo, hi = frame_range
        frames = [f if lo <= i + 1 <= hi else {} for i, f in enumerate(frames)]
    for i, f in enumerate(frames):
        if "x" not in f:
            continue
        t = i / FPS
        y_from_bottom = frame_height - f["y"]
        points.append((t, y_from_bottom))

    n_total = (frame_range[1] - frame_range[0] + 1) if frame_range else len(tracked["frames"])
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
    flight_duration = t.max() - t.min()
    if flight_duration > MAX_PLAUSIBLE_FLIGHT_S:
        return {
            "usable": False,
            "reason": f"flight spans {flight_duration:.2f}s, longer than a real shot's flight "
                      f"plausibly takes -- likely tracking real motion that isn't just the shot",
            "points_used": n_tracked, "tracked_fraction": round(tracked_fraction, 2),
            "flight_duration_s": round(flight_duration, 3),
        }
    t_peak = -b / (2 * a)
    peak_height = a * t_peak ** 2 + b * t_peak + c
    return {
        "usable": True,
        "points_used": n_tracked, "tracked_fraction": round(tracked_fraction, 2),
        "peak_height_px": round(peak_height, 1),
        "time_to_peak_s": round(t_peak - t.min(), 3),
        "flight_duration_s": round(flight_duration, 3),
    }


def fit_shot(tracked, frame_h, key, hoops=None, dunk=False):
    """Hand-labeled range if the shot has one, otherwise search the trajectory for a flight that
    ends at a hoop. Dunks are skipped (the ball is carried by hand, not in free flight)."""
    if dunk:
        return {"usable": False, "reason": "dunk: the ball is carried by hand, not in free flight"}
    labeled = load_shot_range(key)
    if labeled:
        fit = fit_arc(tracked, frame_h, labeled)
        fit["range_source"] = "hand-labeled"
        fit["frame_range"] = list(labeled)
        return fit
    if not hoops:
        return {"usable": False, "reason": "no hoop found in the frames, so a flight can't be checked against one"}
    found = find_flight_segment(tracked, frame_h, hoops)
    if found is None:
        return {"usable": False, "reason": "no stretch of the track looks like a shot flying into a hoop"}
    start, end, details = found
    fit = fit_arc(tracked, frame_h, (start, end))
    fit["range_source"] = "auto-detected"
    fit["frame_range"] = [start, end]
    fit.update(details)
    return fit


def cached_hoops(key):
    """Hoop blobs for a shot, detected once from its frames and cached next to the tracked file.
    Re-extracting a shot's frames writes a new cache, so a stale one never outlives its frames."""
    path = Path(__file__).parent / f"{key}-hoops.json"
    if path.exists():
        return json.loads(path.read_text())
    blobs = detect_hoops(key)
    path.write_text(json.dumps(blobs))
    return blobs


def safe_shot_key(candidate):
    # Unique per real shot (game + exact timestamp), filesystem-safe.
    raw = f"real_{candidate['game_id']}_{candidate['video_time_abs']:.3f}"
    return re.sub(r"[^a-zA-Z0-9_]+", "_", raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=30, help="max shots to run (default 30)")
    parser.add_argument("--seed", type=int, default=7, help="shuffle seed for which shots get picked")
    parser.add_argument("--offset", type=int, default=0, help="skip this many shots of the shuffled list first (a held-out slice)")
    parser.add_argument("--out", default="pipeline_results.json", help="results file name, next to this script")
    args = parser.parse_args()

    candidates = find_clean_candidates()
    print(f"{len(candidates)} eligible clean shots total.")

    random.seed(args.seed)
    random.shuffle(candidates)
    sample = candidates[args.offset: args.offset + args.limit]
    print(f"Running the pipeline on {len(sample)} shots.\n")

    results = []
    for i, cand in enumerate(sample):
        key = safe_shot_key(cand)
        label = f"[{i+1}/{len(sample)}] {cand['shooter']} {'make' if cand['made'] else 'miss'} " \
                f"game={cand['game_id']} t={cand['video_time_local']:.1f}s"
        print(label)
        try:
            (Path(__file__).parent / f"{key}-hoops.json").unlink(missing_ok=True)
            _, _, frames = extract_shot_frames(cand["video_file"], cand["video_time_local"], key)
            if not frames:
                print("  no frames extracted, skipping")
                continue
            from PIL import Image
            frame_h = Image.open(frames[0]).size[1]

            tracked = track_shot(key)
            fit = fit_shot(tracked, frame_h, key, rim_centers(cached_hoops(key)), cand.get("dunk", False))
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

    out_path = Path(__file__).parent / args.out
    out_path.write_text(json.dumps(results, indent=2))

    usable = [r for r in results if r["fit"].get("usable")]
    print(f"\n{len(usable)}/{len(results)} shots produced a usable arc fit.")
    print(f"Wrote {out_path}")

    write_labeling_manifest()  # keep the hand-labeling tool's picker in sync with the new frames


if __name__ == "__main__":
    main()
