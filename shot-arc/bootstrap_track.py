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
import os
from pathlib import Path

from ultralytics import YOLO

from decoys import RADIUS as DECOY_RADIUS, decoys_for

FRAMES_ROOT = Path(__file__).parent / "frames"
# BALL_WEIGHTS swaps in another detector (e.g. the fine-tuned one); BALL_MIN_CONF rejects detections
# below that confidence, so a frame with no convincing ball counts as lost instead of the tracker
# parking on whatever scored highest. The default 0 is the original accept-anything behavior, which
# the original detector needs (it scores the real ball around 0.1).
WEIGHTS_PATH = Path(os.environ.get("BALL_WEIGHTS", Path(__file__).parent / "adam-balldata" / "poolvision-ball-best.pt"))
MIN_CONF = float(os.environ.get("BALL_MIN_CONF", "0"))
# BALL_BRIGHTEN=1 lifts dark frames before detection only (coordinates are unchanged): a dusk game
# is much darker than the rest of its recording, and the detector loses the ball in it (see
# FINDINGS.md). Frames already bright enough are left alone.
BRIGHTEN = os.environ.get("BALL_BRIGHTEN", "") == "1"
BRIGHTEN_TARGET = 125.0
BRIGHTEN_MAX_GAIN = 2.6
CROP = 960
CONF_FLOOR = 0.001  # effectively "any detection at all" -- see FINDINGS.md's calibration finding
LOST_STREAK_LIMIT = 10  # consecutive misses before giving up on a direction
STATIC_EPS = 4.0  # px -- a real ball in flight is essentially never this still frame-to-frame
STATIC_STREAK_LIMIT = 4  # consecutive near-identical detections before suspecting a lock-on
BLACKLIST_RADIUS = 30  # px -- how close counts as "the same spot" once blacklisted

# The seed pass (find_seed, below) only needs ONE rough hit anywhere in the clip -- a low bar by
# design (see module docstring) -- so it doesn't need full source resolution to do its job.
# Detecting against a shrunk copy instead of the native frame (which on Adam's real 4K60 footage
# is 3840x2160, PNG, ~6MB/frame -- ultralytics still decodes and loads the whole thing before its
# own internal resize to imgsz=640) turned a single shot's seed pass into a many-minutes-plus CPU
# job; a small width here keeps it fast while barely affecting seed quality, since the seed step's
# job is just "find approximately where the ball is," not final positioning -- the CROP-based
# tracking pass below still runs against full source resolution, which is where the real detail
# benefit of the 4K footage actually lives (a 960px crop of a 4K frame has real texture on the
# ball; a 960px crop of a 720p frame is most of the whole frame).
SEED_PASS_MAX_WIDTH = 1280


def _brighten(img):
    """Scales a dark PIL image toward BRIGHTEN_TARGET average brightness (gain capped at
    BRIGHTEN_MAX_GAIN); returns it unchanged if it is already bright enough."""
    import numpy as np
    from PIL import Image

    arr = np.asarray(img.convert("RGB"), dtype=np.float32)
    mean = float(arr.mean())
    if mean >= BRIGHTEN_TARGET - 5 or mean <= 1:
        return img
    gain = min(BRIGHTEN_MAX_GAIN, BRIGHTEN_TARGET / mean)
    return Image.fromarray(np.clip(arr * gain, 0, 255).astype(np.uint8))


def top1_detection(model, image_or_path, is_decoy=None):
    """Highest-confidence detection that isn't sitting on a known decoy (see decoys.py). is_decoy
    takes a center in this image's own coordinates."""
    if BRIGHTEN and not isinstance(image_or_path, (str, Path)):
        image_or_path = _brighten(image_or_path)
    r = model.predict(image_or_path, verbose=False, conf=CONF_FLOOR, imgsz=640)[0]
    for b in sorted(r.boxes, key=lambda b: -float(b.conf[0])):
        if float(b.conf[0]) < MIN_CONF:
            break
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        if is_decoy is None or not is_decoy(cx, cy):
            return (cx, cy, float(b.conf[0]))
    return None


def cropped_detect(model, img, cx, cy, is_decoy=None):
    """Crops CROPxCROP centered on (cx, cy), clamped to the image, and returns a detection
    translated back into full-frame coordinates."""
    w, h = img.size
    half = CROP / 2
    x1 = int(max(0, min(w - CROP, cx - half))) if w > CROP else 0
    y1 = int(max(0, min(h - CROP, cy - half))) if h > CROP else 0
    crop_w, crop_h = min(CROP, w), min(CROP, h)
    crop = img.crop((x1, y1, x1 + crop_w, y1 + crop_h))
    hit = top1_detection(model, crop, (lambda x, y: is_decoy(x1 + x, y1 + y)) if is_decoy else None)
    if hit is None:
        return None
    px, py, conf = hit
    return (x1 + px, y1 + py, conf)


def find_seed(model, frame_paths, is_decoy=None):
    """Full-frame pass across every frame, looking for the single best detection anywhere in the
    clip -- accepts a low hit rate (see module docstring) since only one good frame is needed.
    Detects against a shrunk copy of each frame (see SEED_PASS_MAX_WIDTH) and scales the hit back
    up to full-resolution coordinates, so this stays fast even on native 4K source frames."""
    from PIL import Image

    best = None  # (frame_index, x, y, conf)
    for i, path in enumerate(frame_paths):
        img = Image.open(path)
        w, h = img.size
        if w > SEED_PASS_MAX_WIDTH:
            scale = w / SEED_PASS_MAX_WIDTH
            img = img.resize((SEED_PASS_MAX_WIDTH, round(h / scale)))
        else:
            scale = 1.0
        hit = top1_detection(model, img, (lambda x, y, s=scale: is_decoy(x * s, y * s)) if is_decoy else None)
        if hit is None:
            continue
        x, y, conf = hit
        x, y = x * scale, y * scale
        if best is None or conf > best[3]:
            best = (i, x, y, conf)
    return best


def track_shot(shot_key, seed_frame=None, seed_xy=None):
    from PIL import Image

    frame_paths = sorted((FRAMES_ROOT / shot_key).glob("frame_*.png"))
    if not frame_paths:
        raise SystemExit(f"no frames found for {shot_key} in {FRAMES_ROOT}")

    model = YOLO(str(WEIGHTS_PATH))
    decoy_points = decoys_for(shot_key)
    is_decoy = (lambda x, y: any(((x - dx) ** 2 + (y - dy) ** 2) ** 0.5 < DECOY_RADIUS for dx, dy in decoy_points)) if decoy_points else None

    if seed_frame is not None and seed_xy is not None:
        seed = (seed_frame, seed_xy[0], seed_xy[1], 1.0)
        print(f"Using manual seed: frame {seed_frame}, ({seed_xy[0]:.0f}, {seed_xy[1]:.0f})")
    else:
        print(f"Seeding: full-frame detection across {len(frame_paths)} frames...")
        seed = find_seed(model, frame_paths, is_decoy)
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
    results[seed_idx] = {"x": round(seed[1], 1), "y": round(seed[2], 1), "source": "seed", "conf": round(seed[3], 3)}

    def propagate(direction):
        # Caught at scale (see FINDINGS.md): a moving crop can lock onto a stationary background
        # object -- something ball-shaped and confident, just not the ball -- and the original
        # version of this loop had no way to notice, since "found a detection every frame" looked
        # exactly like successful tracking. A real ball in flight is essentially never static for
        # more than a couple frames; once one position repeats past STATIC_STREAK_LIMIT, it gets
        # blacklisted for the rest of this direction so the tracker is forced to either find the
        # real, moving ball elsewhere or honestly give up (lost_streak), instead of quietly
        # continuing to report the same dead spot as a "tracked" position.
        cx, cy = seed[1], seed[2]
        last_xy = (seed[1], seed[2])
        lost_streak = 0
        static_streak = 0
        blacklist_xy = None

        def near_blacklist(hit):
            if hit is None or blacklist_xy is None:
                return False
            x, y, _ = hit
            return ((x - blacklist_xy[0]) ** 2 + (y - blacklist_xy[1]) ** 2) ** 0.5 < BLACKLIST_RADIUS

        i = seed_idx + direction
        while 0 <= i < n:
            img = Image.open(frame_paths[i])
            hit = cropped_detect(model, img, cx, cy, is_decoy)
            if near_blacklist(hit):
                hit = None
            if hit is None:
                # Recovery attempt: try the full frame once before calling this one lost.
                full_hit = top1_detection(model, img, is_decoy)
                hit = None if near_blacklist(full_hit) else full_hit

            if hit is not None:
                x, y, conf = hit
                dist = ((x - last_xy[0]) ** 2 + (y - last_xy[1]) ** 2) ** 0.5
                static_streak = static_streak + 1 if dist < STATIC_EPS else 0
                if static_streak > STATIC_STREAK_LIMIT and blacklist_xy is None:
                    blacklist_xy = (x, y)
                    print(f"  Frame {i}: position ({x:.0f}, {y:.0f}) held static for "
                          f"{static_streak} frames -- treating as a locked-on background object, "
                          f"blacklisting it for the rest of this direction.")
                    hit = None  # this frame's own detection is the stuck one -- don't trust it

            if hit is not None:
                x, y, conf = hit
                results[i] = {"x": round(x, 1), "y": round(y, 1), "source": "tracked", "conf": round(conf, 3)}
                cx, cy = x, y
                last_xy = (x, y)
                lost_streak = 0
            else:
                results[i] = None
                lost_streak += 1
                # cx, cy intentionally NOT updated here -- a rejected detection shouldn't anchor
                # the next frame's crop back onto the same dead spot.
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
