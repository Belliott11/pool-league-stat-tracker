"""Finds the hoops in a shot's own frames: the rim is orange-red and stationary, everything else
(people, caps, the ball) moves. A pixel counts when it is orange in most of the sampled frames;
the surviving blobs are the rims (and occasionally a stationary orange object, which the caller
can tolerate since it only ever asks "is the flight's end near one of these"). The camera drifts a
little within a recording and differs between recordings, so this runs per shot instead of using
fixed coordinates."""
from pathlib import Path

import cv2
import numpy as np

FRAMES_ROOT = Path(__file__).parent / "frames"
SCALE = 960 / 3840
SAMPLE_EVERY = 6
FRACTION = 0.7        # share of sampled frames a pixel must be orange in
MIN_BLOB_AREA = 15    # in the 960px-wide working image


def detect_hoops(shot_key):
    files = sorted((FRAMES_ROOT / shot_key).glob("frame_*.png"))[::SAMPLE_EVERY]
    if not files:
        return []
    acc = None
    for f in files:
        img = cv2.resize(cv2.imread(str(f)), None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_AREA)
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        mask = (((hsv[..., 0] <= 20) | (hsv[..., 0] >= 165)) & (hsv[..., 1] > 90) & (hsv[..., 2] > 80)).astype(np.float32)
        acc = mask if acc is None else acc + mask
    stationary = cv2.dilate((acc / len(files) >= FRACTION).astype(np.uint8), np.ones((5, 5), np.uint8))
    n, _, stats, centers = cv2.connectedComponentsWithStats(stationary)
    blobs = [
        {"x": float(centers[i][0] / SCALE), "y": float(centers[i][1] / SCALE), "w": float(stats[i, 2] / SCALE),
         "h": float(stats[i, 3] / SCALE), "area": int(stats[i, 4])}
        for i in range(1, n) if stats[i, 4] >= MIN_BLOB_AREA
    ]
    blobs.sort(key=lambda b: -b["area"])
    return blobs[:12]


def rim_centers(blobs):
    """Keeps only ring-shaped blobs: a rim seen from above is wider than tall and a fixed size.
    Drops the tall red backboard pole, cones, towels and other stationary orange things. In a dark
    clip the rims are faint and small, so when nothing passes the shape test the two biggest blobs
    are used instead."""
    strict = [(b["x"], b["y"]) for b in blobs if b["w"] >= 1.15 * b["h"] and 90 <= b["w"] <= 280 and b["area"] >= 300]
    if strict:
        return strict
    return [(b["x"], b["y"]) for b in blobs[:2]]
