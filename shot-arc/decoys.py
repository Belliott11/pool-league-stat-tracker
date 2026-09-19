"""Fixed objects the ball detector keeps mistaking for the ball (the white and blue posts of the pool
volleyball stands, the ladder, towels). The camera is nearly still within a recording, so a decoy
sits at nearly the same pixel in every shot from that recording, and the tracker reports it for
dozens of frames because nothing else is more ball-like. A real ball is never that persistent at
one spot across many separate shots, so pixels where the tracker has repeatedly parked, across
several different shots of the same recording, are decoys. Built from the tracked files that
already exist; the tracker skips detections near them.

Usage: python decoys.py   (rebuilds decoys.json from every *-tracked.json)"""
import json
from collections import defaultdict
from pathlib import Path

from hoops import rim_centers
from select_sample_shots import GAME_4K_SOURCE

HERE = Path(__file__).parent
DECOYS_PATH = HERE / "decoys.json"
CELL = 60                # px; grid size used to find repeat locations
MIN_SHOTS = 4            # distinct shots that must have parked there
MIN_FRAMES = 60          # total frames tracked there across those shots
RADIUS = 70              # px around a decoy cell center that the tracker ignores
RIM_CLEARANCE = 250      # never call something near a rim a decoy: a real shot's ball ends there


def recording_of(key):
    return GAME_4K_SOURCE[key.split("_")[1]].name


def build():
    cells = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))  # recording -> cell -> shot -> frames
    for f in sorted(HERE.glob("real_*-tracked.json")):
        key = f.name[: -len("-tracked.json")]
        try:
            rec = recording_of(key)
        except KeyError:
            continue
        for fr in json.loads(f.read_text(encoding="utf-8"))["frames"]:
            if "x" in fr:
                cells[rec][(int(fr["x"] // CELL), int(fr["y"] // CELL))][key] += 1
    rims = defaultdict(list)
    for f in HERE.glob("real_*-hoops.json"):
        key = f.name[: -len("-hoops.json")]
        try:
            blobs = json.loads(f.read_text())
            if blobs and isinstance(blobs[0], dict):
                rims[recording_of(key)].extend(rim_centers(blobs))
        except (KeyError, ValueError):
            continue
    out = {}
    for rec, grid in cells.items():
        found = []
        for (cx, cy), shots in grid.items():
            x, y = cx * CELL + CELL / 2, cy * CELL + CELL / 2
            near_rim = any(((x - rx) ** 2 + (y - ry) ** 2) ** 0.5 < RIM_CLEARANCE for rx, ry in rims[rec])
            if len(shots) >= MIN_SHOTS and sum(shots.values()) >= MIN_FRAMES and not near_rim:
                found.append([cx * CELL + CELL / 2, cy * CELL + CELL / 2, sum(shots.values())])
        out[rec] = sorted(found, key=lambda d: -d[2])
    DECOYS_PATH.write_text(json.dumps(out))
    return out


def load():
    return json.loads(DECOYS_PATH.read_text()) if DECOYS_PATH.exists() else {}


def decoys_for(key):
    try:
        return [(x, y) for x, y, _ in load().get(recording_of(key), [])]
    except KeyError:
        return []


if __name__ == "__main__":
    for rec, d in build().items():
        print(rec, len(d), "decoy cells; strongest:", [(int(x), int(y), n) for x, y, n in d[:6]])
