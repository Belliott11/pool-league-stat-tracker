"""
Crop-bootstrapping: finds the ball across a whole shot's frames without needing a human to click
every one, using Adam's fine-tuned ball detector (poolvision-ball-best.pt) the way FINDINGS.md's
own test showed it actually works on our footage -- top-ranked detection in a 960px crop centered
near the ball, not full-frame detection (which the same test found is essentially useless here:
0/120 within 20px on our own footage).

The real problem a fresh, unlabeled shot has that the oracle-crop test in FINDINGS.md didn't: no
crop center to start from, since nobody's told it where the ball is yet. This solves that with
detect-to-track:

  1. SEED: run full-frame detection across every frame anyway, accepting a low hit rate (FINDINGS.md:
     3/120 within 100px on the full frame) -- just need ONE decent hit anywhere in the clip to
     start from, not a high rate. Picks the single highest-confidence detection across the whole
     clip as the seed.
  2. TRACK: from the seed frame, propagate outward frame-by-frame in both directions. Each step
     crops 960x960 centered on the PREVIOUS frame's own found position (the ball can't jump far
     frame-to-frame at 30fps) and runs the detector there, taking its top-1 detection regardless of
     confidence score (FINDINGS.md's calibration finding: confidence is unreliable, ranking isn't).
  3. RECOVERY: a frame with no detection at all in the tracked crop gets one retry against the
     full frame before being marked lost; the crop center carries forward unchanged through a lost
     frame rather than resetting, so a brief miss doesn't derail the frames after it. Too many
     consecutive losses in one direction (LOST_STREAK_LIMIT) stops tracking that direction rather
     than drifting on stale data.

Manual seed override (--seed-frame/--seed-x/--seed-y) exists for when auto-seeding fails or a human
already knows a good starting point (e.g. from the hand-labeling tool).
"""
import argparse
import json
from pathlib import Path

from ultralytics import YOLO

FRAMES_ROOT = Path(__file__).parent / "frames"
WEIGHTS_PATH = Path(__file__).parent / "adam-balldata" / "poolvision-ball-best.pt"
CROP = 960
CONF_FLOOR = 0.001  # effectively "any detection at all" -- see FINDINGS.md's calibration finding
LOST_STREAK_LIMIT = 10  # consecutive misses before giving up on a direction


def top1_detection(model, image_or_path):
    r = model.predict(image_or_path, verbose=False, conf=CONF_FLOOR, imgsz=640)[0]
    if len(r.boxes) == 0:
        return None
    best = max(r.boxes, key=lambda b: float(b.conf[0]))
    x1, y1, x2, y2 = best.xyxy[0].tolist()
    return ((x1 + x2) / 2, (y1 + y2) / 2, float(best.conf[0]))


def cropped_detect(model, img, cx, cy):
    """Crops CROPxCROP centered on (cx, cy), clamped to the image, and returns a detection
    translated back into full-frame coordinates."""
    w, h = img.size
    half = CROP / 2
    x1 = int(max(0, min(w - CROP, cx - half))) if w > CROP else 0
    y1 = int(max(0, min(h - CROP, cy - half))) if h > CROP else 0
    crop_w, crop_h = min(CROP, w), min(CROP, h)
    crop = img.crop((x1, y1, x1 + crop_w, y1 + crop_h))
    hit = top1_detection(model, crop)
    if hit is None:
        return None
    px, py, conf = hit
    return (x1 + px, y1 + py, conf)


def find_seed(model, frame_paths):
    """Full-frame pass across every frame, looking for the single best detection anywhere in the
    clip -- accepts a low hit rate (see module docstring) since only one good frame is needed."""
    best = None  # (frame_index, x, y, conf)
    for i, path in enumerate(frame_paths):
        hit = top1_detection(model, str(path))
        if hit is None:
            continue
        x, y, conf = hit
        if best is None or conf > best[3]:
            best = (i, x, y, conf)
    return best


def track_shot(shot_key, seed_frame=None, seed_xy=None):
    from PIL import Image

    frame_paths = sorted((FRAMES_ROOT / shot_key).glob("frame_*.png"))
    if not frame_paths:
        raise SystemExit(f"no frames found for {shot_key} in {FRAMES_ROOT}")

    model = YOLO(str(WEIGHTS_PATH))

    if seed_frame is not None and seed_xy is not None:
        seed = (seed_frame, seed_xy[0], seed_xy[1], 1.0)
        print(f"Using manual seed: frame {seed_frame}, ({seed_xy[0]:.0f}, {seed_xy[1]:.0f})")
    else:
        print(f"Seeding: full-frame detection across {len(frame_paths)} frames...")
        seed = find_seed(model, frame_paths)
        if seed is None:
            raise SystemExit(
                f"No detection anywhere in {shot_key}'s {len(frame_paths)} frames -- "
                "can't auto-seed. Try --seed-frame/--seed-x/--seed-y with a hand-picked point."
            )
        print(f"Seed found: frame {seed[0]} ({frame_paths[seed[0]].name}), "
              f"({seed[1]:.0f}, {seed[2]:.0f}), conf={seed[3]:.3f}")

    n = len(frame_paths)
    seed_idx = seed[0]
    results = [None] * n  # each entry: {"x","y","source"} or None
    results[seed_idx] = {"x": round(seed[1], 1), "y": round(seed[2], 1), "source": "seed"}

    def propagate(direction):
        cx, cy = seed[1], seed[2]
        lost_streak = 0
        i = seed_idx + direction
        while 0 <= i < n:
            img = Image.open(frame_paths[i])
            hit = cropped_detect(model, img, cx, cy)
            if hit is None:
                # Recovery attempt: try the full frame once before calling this one lost.
                full_hit = top1_detection(model, img)
                hit = full_hit
            if hit is not None:
                x, y, conf = hit
                results[i] = {"x": round(x, 1), "y": round(y, 1), "source": "tracked"}
                cx, cy = x, y
                lost_streak = 0
            else:
                results[i] = None
                lost_streak += 1
                if lost_streak > LOST_STREAK_LIMIT:
                    print(f"  Lost track {['backward','forward'][direction>0]} at frame {i} "
                          f"({lost_streak} consecutive misses) -- stopping this direction.")
                    break
            i += direction

    propagate(1)
    propagate(-1)

    found = sum(1 for r in results if r is not None)
    print(f"Tracked {found}/{n} frames ({found/n:.0%}).")

    output = {
        "shotKey": shot_key,
        "seedFrame": seed_idx,
        "frames": [
            {"filename": frame_paths[i].name, **(results[i] or {"source": "lost"})}
            for i in range(n)
        ],
    }
    out_path = Path(__file__).parent / f"{shot_key}-tracked.json"
    out_path.write_text(json.dumps(output, indent=2))
    print(f"Wrote {out_path}")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shot_key", help="e.g. 00_Evan_make (must exist under shot-arc/frames/)")
    parser.add_argument("--seed-frame", type=int, default=None, help="0-based frame index to seed from")
    parser.add_argument("--seed-x", type=float, default=None)
    parser.add_argument("--seed-y", type=float, default=None)
    args = parser.parse_args()

    seed_xy = (args.seed_x, args.seed_y) if args.seed_x is not None and args.seed_y is not None else None
    track_shot(args.shot_key, seed_frame=args.seed_frame, seed_xy=seed_xy)
