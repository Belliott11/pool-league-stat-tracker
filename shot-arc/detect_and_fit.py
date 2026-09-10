"""
Steps 2-5 of the per-shot pipeline (standalone-shot-arc-plan.md):
  2. Detect the ball each frame with a pretrained detector's generic "sports ball" class
     (COCO class 32) -- stock detection first, per the plan's own advice, before reaching for
     anything fancier.
  3. Get the ball's center position per frame where detected; frames with no detection are
     skipped (a partial trajectory is fine).
  4. Fit a parabola to the (time, height) points with a basic least-squares quadratic fit.
  5. Extract peak height, time-to-peak, flight duration, and points-used-in-fit as a rough
     confidence signal.

Height is tracked as "pixels from the bottom of the frame" (so a real upward arc is a positive
number that rises then falls), since there's no depth information to convert pixels to real-world
units from a single fixed overhead-angle camera -- consistent with the plan's own "table joining
back to the existing shot log" output, which only needs relative arc shape (peak, duration),
not absolute physical height.
"""
import json
from pathlib import Path

import numpy as np
from ultralytics import YOLO

SPORTS_BALL_CLASS = 32  # COCO class id
CONF_THRESHOLD = 0.1  # low bar on purpose -- a small ball at this camera distance is a hard,
                       # low-confidence detection even when it's the right one; the real filter
                       # is "did we get enough points for a sane parabola fit," not per-frame conf
INFERENCE_SIZE = 1280  # full frame width -- the default 640 downscale shrinks an already-small
                        # ball (see FINDINGS.md) to almost nothing; even at 1280 stock detection
                        # basically doesn't find it on real in-flight shots (see FINDINGS.md) --
                        # left at the best config found during prototyping, not because it works
MIN_POINTS_FOR_FIT = 4
FRAMES_ROOT = Path(__file__).parent / "frames"
FPS = 30


def detect_ball_positions(model, frame_paths):
    points = []  # (t_seconds, x_px, y_from_bottom_px, conf)
    results = model.predict([str(p) for p in frame_paths], verbose=False, conf=CONF_THRESHOLD, imgsz=INFERENCE_SIZE)
    for i, r in enumerate(results):
        t = i / FPS
        best = None
        for box in r.boxes:
            if int(box.cls[0]) != SPORTS_BALL_CLASS:
                continue
            conf = float(box.conf[0])
            if best is None or conf > best[0]:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cx = (x1 + x2) / 2
                cy = (y1 + y2) / 2
                img_h = r.orig_shape[0]
                best = (conf, t, cx, img_h - cy)  # flip y so "up" is positive
        if best:
            points.append((best[1], best[2], best[3], best[0]))
    return points


def fit_parabola(points):
    if len(points) < MIN_POINTS_FOR_FIT:
        return None
    t = np.array([p[0] for p in points])
    y = np.array([p[2] for p in points])
    coeffs = np.polyfit(t, y, 2)  # y = a*t^2 + b*t + c
    a, b, c = coeffs
    if a >= 0:
        # Not a real downward-opening arc (detections are too noisy/sparse to trust here) --
        # flag rather than report a nonsense "peak."
        return {"points_used": len(points), "usable": False, "reason": "fit did not open downward"}
    t_peak = -b / (2 * a)
    peak_height = a * t_peak ** 2 + b * t_peak + c
    t_start, t_end = t.min(), t.max()
    return {
        "points_used": len(points),
        "usable": True,
        "peak_height_px": round(peak_height, 1),
        "time_to_peak_s": round(t_peak - t_start, 3),
        "flight_duration_s": round(t_end - t_start, 3),
        "t_peak_in_window": round(t_peak, 3),
        "window_span_s": round(t_end - t_start, 3),
    }


def main():
    shots = json.loads((Path(__file__).parent / "sample_shots.json").read_text())
    model = YOLO("yolov8n.pt")
    results = []
    for i, s in enumerate(shots):
        key = f"{i:02d}_{s['shooter']}_{'make' if s['made'] else 'miss'}"
        frame_dir = FRAMES_ROOT / key
        frames = sorted(frame_dir.glob("frame_*.png"))
        if not frames:
            print(f"{key}: no frames found, skipping")
            continue
        points = detect_ball_positions(model, frames)
        fit = fit_parabola(points)
        row = {
            "key": key, "shooter": s["shooter"], "made": s["made"],
            "game_id": s["game_id"], "video_time_abs": s["video_time_abs"],
            "frames_total": len(frames), "frames_with_ball": len(points),
            "detection_rate": round(len(points) / len(frames), 2),
            "fit": fit,
        }
        results.append(row)
        fit_desc = "no fit (too few points)" if fit is None else (
            f"peak={fit['peak_height_px']}px @ t={fit['t_peak_in_window']:.2f}s, "
            f"duration={fit['flight_duration_s']:.2f}s" if fit.get("usable")
            else f"fit unusable: {fit['reason']}"
        )
        print(f"{key}: ball found in {len(points)}/{len(frames)} frames ({row['detection_rate']:.0%}) -- {fit_desc}")

    out_path = Path(__file__).parent / "results.json"
    out_path.write_text(json.dumps(results, indent=2))
    print(f"\nWrote {out_path}")

    usable = [r for r in results if r["fit"] and r["fit"].get("usable")]
    print(f"\n{len(usable)}/{len(results)} shots produced a usable arc fit.")
    if usable:
        avg_detect = sum(r["detection_rate"] for r in results) / len(results)
        print(f"Average per-frame detection rate across all {len(results)} sampled shots: {avg_detect:.0%}")


if __name__ == "__main__":
    main()
