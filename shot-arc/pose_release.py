"""
Release-point tracking prototype (Part 3 of the video-backed dev spec), using stock
yolo11s-pose.pt -- the same model PoolVision itself uses un-fine-tuned (see POOLVISION-NOTES.md),
so unlike ball detection this needs no local training data at all.

For each sample shot, run pose detection across the frame window, and for every detected person
track wrist height relative to their own shoulder line (in shoulder-widths, same normalization
PoolVision's facing.py/shooter.py use) over time. A real release should show a rise-then-fall in
wrist height around the shot's own videoTime, roughly bracketing where a parabola's own origin
would be.

Keypoint indices are the standard Ultralytics/COCO-17 order: 0 nose, 5/6 shoulders, 9/10 wrists.
"""
import json
from pathlib import Path

from ultralytics import YOLO

FRAMES_ROOT = Path(__file__).parent / "frames"
FPS = 30
POSE_CONF = 0.15
NOSE, LSH, RSH, LWR, RWR = 0, 5, 6, 9, 10


def wrist_height_metric(kp):
    """Highest wrist above the shoulder line, in shoulder-widths (positive = above).

    Shoulder-width normalizes for how close/far this person is from the camera, same reasoning
    PoolVision's own facing.py uses for its own wrist-vs-head measurements.
    """
    lsh, rsh = kp[LSH], kp[RSH]
    if lsh[2] < 0.3 or rsh[2] < 0.3:
        return None
    shoulder_y = (lsh[1] + rsh[1]) / 2
    shoulder_width = abs(lsh[0] - rsh[0])
    if shoulder_width < 3:
        return None
    best = None
    for w in (kp[LWR], kp[RWR]):
        if w[2] < 0.3:
            continue
        # Image y grows downward, so "above the shoulder" is a smaller y -- flip sign so a
        # real raised-arms release reads as a positive number, same convention arc.py uses
        # for its own vertical fit (gravity positive, "up" reads as the intuitive direction).
        above = (shoulder_y - w[1]) / shoulder_width
        if best is None or above > best:
            best = above
    return best


def main():
    shots = json.loads((Path(__file__).parent / "sample_shots.json").read_text())
    model = YOLO("yolo11s-pose.pt")
    results = []
    for i, s in enumerate(shots):
        key = f"{i:02d}_{s['shooter']}_{'make' if s['made'] else 'miss'}"
        frames = sorted((FRAMES_ROOT / key).glob("frame_*.png"))
        if not frames:
            continue
        preds = model.predict([str(f) for f in frames], verbose=False, conf=POSE_CONF, imgsz=1280)

        series = []  # (t, max wrist-height-above-shoulder across all detected people)
        people_per_frame = []
        for fi, r in enumerate(preds):
            t = fi / FPS
            people_per_frame.append(0 if r.keypoints is None else len(r.keypoints.data))
            if r.keypoints is None or len(r.keypoints.data) == 0:
                continue
            best_frame = None
            for kp in r.keypoints.data.tolist():
                m = wrist_height_metric(kp)
                if m is not None and (best_frame is None or m > best_frame):
                    best_frame = m
            if best_frame is not None:
                series.append((round(t, 3), round(best_frame, 2)))

        frames_with_people = sum(1 for c in people_per_frame if c > 0)
        frames_with_wrists = len(series)
        peak = max(series, key=lambda p: p[1]) if series else None
        results.append({
            "key": key, "shooter": s["shooter"], "made": s["made"],
            "frames_total": len(frames),
            "frames_with_a_person": frames_with_people,
            "frames_with_readable_wrists": frames_with_wrists,
            "wrist_series": series,
            "peak_wrist_height": peak,
        })
        print(f"{key}: person detected in {frames_with_people}/{len(frames)} frames "
              f"({frames_with_people/len(frames):.0%}), wrists readable in {frames_with_wrists}/{len(frames)} "
              f"({frames_with_wrists/len(frames):.0%})"
              + (f" -- peak {peak[1]} shoulder-widths above shoulder at t={peak[0]}s" if peak else ""))

    out_path = Path(__file__).parent / "pose_results.json"
    out_path.write_text(json.dumps(results, indent=2))

    total_frames = sum(r["frames_total"] for r in results)
    total_person = sum(r["frames_with_a_person"] for r in results)
    total_wrists = sum(r["frames_with_readable_wrists"] for r in results)
    print(f"\nOVERALL across {len(results)} shots, {total_frames} frames:")
    print(f"  person detected:  {total_person}/{total_frames} ({total_person/total_frames:.0%})")
    print(f"  wrists readable:  {total_wrists}/{total_frames} ({total_wrists/total_frames:.0%})")
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
