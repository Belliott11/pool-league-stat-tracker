"""Builds a YOLO fine-tuning set from footage we've already verified by eye.

Positives: every frame inside an accepted (checked) arc. Where the detector found the ball and it
agrees with the arc, that measured position is used; where it missed for a few frames the position
is interpolated between the detections on either side, so some of the frames it fails on are in
the set too, not just the ones it already got. Crops are 960px like the tracker's, with the ball
placed at a random offset so the model doesn't learn "the ball is centered".
Negatives: empty crops centered on known decoys (post tops, ladder, drain cap, spare ball) and on
rims, taken from the start of a window, before any flight, so they teach "not the ball".
Split by shot (not by frame) so validation measures unseen shots.

Usage: python build_ball_dataset.py"""
import hashlib
import json
import random
from pathlib import Path

import numpy as np
from PIL import Image

import decoys
from hoops import rim_centers
from run_pipeline import FPS  # noqa: F401  (documented dependency on the shared frame rate)
from select_sample_shots import GAME_4K_SOURCE

HERE = Path(__file__).parent
OUT = HERE / "balldata_local"
CROP = 960
WEIGHTS = HERE / "adam-balldata" / "poolvision-ball-best.pt"
BOX = 54  # px, one consistent ball box (the old detector's own boxes ranged 24-70px, mostly too small)
DETECTION_TOLERANCE_PX = 90  # a detection within this of the fitted arc is trusted as the ball
INTERP_MAX_GAP = 4  # longest run of missed frames filled in by a line between neighbouring detections
H = 2160
NEG_PER_RECORDING = 60
VAL_FRACTION = 0.25


def is_val(key):
    return int(hashlib.md5(key.encode()).hexdigest(), 16) % 100 < VAL_FRACTION * 100


def crop_around(img, cx, cy, rng, jitter=300):
    """A CROP x CROP window that contains (cx, cy) at a random offset from its center."""
    w, h = img.size
    ox = cx - CROP / 2 + rng.uniform(-jitter, jitter)
    oy = cy - CROP / 2 + rng.uniform(-jitter, jitter)
    x1 = int(max(0, min(w - CROP, ox)))
    y1 = int(max(0, min(h - CROP, oy)))
    return img.crop((x1, y1, x1 + CROP, y1 + CROP)), x1, y1


def main():
    rng = random.Random(5)
    for split in ("train", "val"):
        (OUT / "images" / split).mkdir(parents=True, exist_ok=True)
        (OUT / "labels" / split).mkdir(parents=True, exist_ok=True)

    results = json.loads((HERE / "pipeline_results_refit.json").read_text())
    accepted = [r for r in results if r["fit"].get("usable")]
    counts = {"train": [0, 0, 0], "val": [0, 0, 0]}  # [ball frames, empty frames, of the ball frames: filled in from the arc]

    for r in accepted:
        key = r["shot_key"]
        split = "val" if is_val(key) else "train"
        tracked = json.loads((HERE / f"{key}-tracked.json").read_text(encoding="utf-8"))["frames"]
        lo, hi = r["fit"]["frame_range"]
        # Detections inside the verified flight. The fitted arc only approximates the real path (it
        # drifts most near the hoop), so it is used as a sanity check on detections, not to overwrite
        # them: a detection within DETECTION_TOLERANCE_PX of the arc is trusted as the ball.
        pts = [(i / FPS, f["x"], H - f["y"]) for i, f in enumerate(tracked) if "x" in f and lo <= i + 1 <= hi]
        t = np.array([p[0] for p in pts]); xs = np.array([p[1] for p in pts]); ys = np.array([p[2] for p in pts])
        px, py = np.polyfit(t, xs, 1), np.polyfit(t, ys, 2)
        det = {}
        for i in range(lo - 1, hi):
            f = tracked[i]
            if "x" not in f:
                continue
            u = i / FPS
            fx, fy = float(np.polyval(px, u)), float(H - np.polyval(py, u))
            if ((f["x"] - fx) ** 2 + (f["y"] - fy) ** 2) ** 0.5 <= DETECTION_TOLERANCE_PX:
                det[i] = (f["x"], f["y"])
        for i in range(lo - 1, hi):
            if i in det:
                cx0, cy0 = det[i]
                filled = False
            else:
                # A gap: the detector missed the ball here. Fill it by a straight line between the
                # nearest detections on either side, only for short gaps, where a line is accurate.
                prev = next((j for j in range(i - 1, max(lo - 2, i - INTERP_MAX_GAP - 1), -1) if j in det), None)
                nxt = next((j for j in range(i + 1, min(hi, i + INTERP_MAX_GAP + 1)) if j in det), None)
                if prev is None or nxt is None:
                    continue
                w = (i - prev) / (nxt - prev)
                cx0 = det[prev][0] + (det[nxt][0] - det[prev][0]) * w
                cy0 = det[prev][1] + (det[nxt][1] - det[prev][1]) * w
                filled = True
            img = Image.open(HERE / "frames" / key / f"frame_{i + 1:04d}.png").convert("RGB")
            crop, x1, y1 = crop_around(img, cx0, cy0, rng)
            cx, cy = cx0 - x1, cy0 - y1
            stem = f"{key}_{i + 1:04d}" + ("_i" if filled else "")
            crop.save(OUT / "images" / split / f"{stem}.jpg", quality=92)
            (OUT / "labels" / split / f"{stem}.txt").write_text(f"0 {cx / CROP:.6f} {cy / CROP:.6f} {BOX / CROP:.6f} {BOX / CROP:.6f}\n")
            counts[split][0] += 1
            counts[split][2] += 1 if filled else 0

    # Negatives: decoy and rim spots, from the first 20 frames of shots in that recording (before any flight).
    by_recording = {}
    for f in sorted(HERE.glob("real_*-tracked.json")):
        key = f.name[: -len("-tracked.json")]
        try:
            by_recording.setdefault(GAME_4K_SOURCE[key.split("_")[1]].name, []).append(key)
        except KeyError:
            pass
    dec = decoys.load()
    for rec, keys in by_recording.items():
        spots = [(x, y) for x, y, _ in dec.get(rec, [])]
        for k in keys:
            cache = HERE / f"{k}-hoops.json"
            if cache.exists():
                blobs = json.loads(cache.read_text())
                if blobs and isinstance(blobs[0], dict):
                    spots += rim_centers(blobs)
        if not spots:
            continue
        for n in range(NEG_PER_RECORDING):
            key = rng.choice(keys)
            frame_no = rng.randint(1, 20)
            path = HERE / "frames" / key / f"frame_{frame_no:04d}.png"
            if not path.exists():
                continue
            sx, sy = rng.choice(spots)
            img = Image.open(path).convert("RGB")
            crop, x1, y1 = crop_around(img, sx, sy, rng, jitter=200)
            split = "val" if is_val(key) else "train"
            stem = f"neg_{rec[:-4]}_{n:03d}_{key[5:]}"
            crop.save(OUT / "images" / split / f"{stem}.jpg", quality=92)
            (OUT / "labels" / split / f"{stem}.txt").write_text("")
            counts[split][1] += 1

    (OUT / "data.yaml").write_text(
        f"path: {OUT.as_posix()}\ntrain: images/train\nval: images/val\nnames:\n  0: ball\n"
    )
    for split in ("train", "val"):
        print(f"{split}: {counts[split][0]} ball frames ({counts[split][2]} interpolated across short detection gaps) + {counts[split][1]} empty")
    print(f"shots: {sum(1 for r in accepted if not is_val(r['shot_key']))} train, {sum(1 for r in accepted if is_val(r['shot_key']))} val")


if __name__ == "__main__":
    main()
