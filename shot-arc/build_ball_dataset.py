"""Builds a YOLO fine-tuning set from footage we've already verified by eye.

Positives: every frame inside an accepted (checked) arc. The tracked position there is on the ball;
the box size comes from the current detector's own box on a crop centered there (the center is the
verified part, the size is just the ball's size). Crops are 960px like the tracker's, with the ball
placed at a random offset so the model doesn't learn "the ball is centered".
Negatives: empty crops centered on known decoys (post tops, ladder, drain cap, spare ball) and on
rims, taken from the start of a window, before any flight, so they teach "not the ball".
Split by shot (not by frame) so validation measures unseen shots.

Usage: python build_ball_dataset.py"""
import hashlib
import json
import random
from pathlib import Path

from PIL import Image
from ultralytics import YOLO

import decoys
from hoops import rim_centers
from run_pipeline import FPS  # noqa: F401  (documented dependency on the shared frame rate)
from select_sample_shots import GAME_4K_SOURCE

HERE = Path(__file__).parent
OUT = HERE / "balldata_local"
CROP = 960
WEIGHTS = HERE / "adam-balldata" / "poolvision-ball-best.pt"
FALLBACK_BOX = 70  # px, used when the detector has no box near a verified position
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
    model = YOLO(str(WEIGHTS))
    for split in ("train", "val"):
        (OUT / "images" / split).mkdir(parents=True, exist_ok=True)
        (OUT / "labels" / split).mkdir(parents=True, exist_ok=True)

    results = json.loads((HERE / "pipeline_results_refit.json").read_text())
    accepted = [r for r in results if r["fit"].get("usable")]
    counts = {"train": [0, 0], "val": [0, 0]}  # [positives, negatives]
    sizes = []

    for r in accepted:
        key = r["shot_key"]
        split = "val" if is_val(key) else "train"
        tracked = json.loads((HERE / f"{key}-tracked.json").read_text(encoding="utf-8"))["frames"]
        lo, hi = r["fit"]["frame_range"]
        for i in range(lo - 1, hi):
            f = tracked[i]
            if "x" not in f:
                continue
            img = Image.open(HERE / "frames" / key / f"frame_{i + 1:04d}.png").convert("RGB")
            crop, x1, y1 = crop_around(img, f["x"], f["y"], rng)
            det = model.predict(crop, verbose=False, conf=0.001, imgsz=640)[0]
            best = None
            for b in det.boxes:
                bx1, by1, bx2, by2 = b.xyxy[0].tolist()
                cx, cy = (bx1 + bx2) / 2 + x1, (by1 + by2) / 2 + y1
                d = ((cx - f["x"]) ** 2 + (cy - f["y"]) ** 2) ** 0.5
                if d < 25 and (best is None or d < best[0]):
                    best = (d, bx2 - bx1, by2 - by1)
            bw, bh = (best[1], best[2]) if best else (FALLBACK_BOX, FALLBACK_BOX)
            if best:
                sizes.append((bw + bh) / 2)
            bw, bh = max(24, min(bw, 160)), max(24, min(bh, 160))
            cx, cy = f["x"] - x1, f["y"] - y1
            stem = f"{key}_{i + 1:04d}"
            crop.save(OUT / "images" / split / f"{stem}.jpg", quality=92)
            (OUT / "labels" / split / f"{stem}.txt").write_text(f"0 {cx / CROP:.6f} {cy / CROP:.6f} {bw / CROP:.6f} {bh / CROP:.6f}\n")
            counts[split][0] += 1

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
    med = sorted(sizes)[len(sizes) // 2] if sizes else None
    print(f"train: {counts['train'][0]} ball frames + {counts['train'][1]} empty; val: {counts['val'][0]} + {counts['val'][1]}")
    print(f"box size from detector on {len(sizes)} frames, median {med:.0f}px" if med else "no detector boxes matched")
    print(f"shots: {sum(1 for r in accepted if not is_val(r['shot_key']))} train, {sum(1 for r in accepted if is_val(r['shot_key']))} val")


if __name__ == "__main__":
    main()
