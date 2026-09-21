"""Gets shots ready for arc-trace.html: pulls a 6 second window of frames around each shot from the 4K
recording (downsized, JPEG, 30 fps) and writes trace/shots.json for the page to read.
By default it picks the shots of the given game(s) that have no arc yet (not in shot_arcs_features.csv),
skipping dunks and shots that share a video time with another shot.
Usage: python trace_prep.py GAME_ID [GAME_ID ...]     (e.g. cmgf3z9rea2l7rc)
Then:  python -m http.server 8000   (from this folder) and open http://localhost:8000/arc-trace.html"""
import csv
import json
import subprocess
import sys
from pathlib import Path

from run_pipeline import safe_shot_key
from select_sample_shots import find_clean_candidates

HERE = Path(__file__).parent
OUT = HERE / "trace"
PRE_ROLL = 1.0
WINDOW = 6.0
WIDTH = 1600
FPS = 30


def main():
    games = set(sys.argv[1:])
    if not games:
        sys.exit(__doc__)
    have = {r["key"] for r in csv.DictReader(open(HERE / "shot_arcs_features.csv", encoding="utf-8"))}
    done_file = HERE / "hand_traces.json"
    done = {t["key"] for t in json.loads(done_file.read_text())} if done_file.exists() else set()
    shots = []
    for c in find_clean_candidates():
        key = safe_shot_key(c)[5:]
        if c["game_id"] not in games or key in have or key in done or c["dunk"]:
            continue
        shots.append((key, c))
    shots.sort(key=lambda kc: kc[1]["video_time_abs"])
    OUT.mkdir(exist_ok=True)
    manifest = []
    for n, (key, c) in enumerate(shots, 1):
        folder = OUT / key
        if not (folder.exists() and len(list(folder.glob("f_*.jpg"))) >= 170):
            folder.mkdir(exist_ok=True)
            start = max(0.0, c["video_time_abs"] - PRE_ROLL)
            subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, start - 2):.3f}", "-i", c["video_file"],
                            "-ss", "2.0", "-t", str(WINDOW), "-vf", f"fps={FPS},scale={WIDTH}:-2", "-q:v", "4", str(folder / "f_%03d.jpg")], check=True)
        frames = len(list(folder.glob("f_*.jpg")))
        manifest.append({"key": key, "shooter": c["shooter"], "points": c["points"], "made": c["made"], "game": c["game_id"],
                         "time": c["video_time_abs"], "frames": frames, "scale": 3840 / WIDTH})
        print(f"{n}/{len(shots)} {key} {c['shooter']} {frames} frames", flush=True)
    (OUT / "shots.json").write_text(json.dumps(manifest, indent=1))
    print(f"{len(manifest)} shots ready. Now run: python -m http.server 8000  and open http://localhost:8000/arc-trace.html")


if __name__ == "__main__":
    main()
