"""
Picks a small handful of real logged shots to prototype ball-detection/arc-fitting against, per
the standalone build plan's own advice: "Worth prototyping against a small handful of clips (5-10
shots) first ... before investing time building the full pipeline."

Pulls from the real exported state (games + scoringEvents, already extracted from
dashboard-viewer/viewer-seed-data.js) and the viewer's own GAME_VIDEO_FILES offset map, so the
output rows point straight at real local video files already on disk with a correct local-clip
time (absolute videoTime translated by that game's own videoStart, same translation
openGameAtTime()/viewer-videos.js already apply in the browser).
"""
import json
import re
import random
from pathlib import Path

STATE_PATH = Path(r"C:\Users\breso\AppData\Local\Temp\claude\C--Users-breso-dashboard\be6cd57e-4d45-44a6-b05b-76c385e5c878\scratchpad\full_state.json")
VIEWER_VIDEOS_JS = Path(r"C:\Users\breso\dashboard-viewer\viewer-videos.js")
GAME_VIDEOS_DIR = Path(r"C:\Users\breso\dashboard-viewer\game-videos")
OUT_PATH = Path(__file__).parent / "sample_shots.json"


def load_game_video_files():
    text = VIEWER_VIDEOS_JS.read_text(encoding="utf-8")
    # Rows look like: "gameId": { file: "game-videos/gameId.mp4", videoStart: 1648.520637 },
    rows = re.findall(r'"([a-z0-9]+)":\s*\{\s*file:\s*"([^"]+)",\s*videoStart:\s*([\d.]+)\s*\}', text)
    return {gid: {"file": file, "videoStart": float(start)} for gid, file, start in rows}


def main():
    state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    hosted = load_game_video_files()
    players = {p["id"]: p["name"] for p in state["players"]}

    candidates = []
    for game in state["games"]:
        gid = game["id"]
        if gid not in hosted:
            continue
        video_path = GAME_VIDEOS_DIR / Path(hosted[gid]["file"]).name
        if not video_path.exists():
            continue
        for ev in game.get("scoringEvents", []):
            if ev.get("videoTime") is None:
                continue
            if ev.get("points") not in (2, 3):
                continue
            if not ev.get("shotLocation"):
                continue
            local_time = ev["videoTime"] - hosted[gid]["videoStart"]
            if local_time < 2:  # need room for the pre-release window
                continue
            candidates.append({
                "game_id": gid,
                "video_file": str(video_path),
                "shooter": players.get(ev.get("scorerId"), "?"),
                "made": ev.get("made") is not False,
                "points": ev["points"],
                "video_time_abs": ev["videoTime"],
                "video_time_local": local_time,
                "shot_location": ev["shotLocation"],
            })

    random.seed(11)  # deterministic sample selection
    makes = [c for c in candidates if c["made"]]
    misses = [c for c in candidates if not c["made"]]
    random.shuffle(makes)
    random.shuffle(misses)
    sample = makes[:5] + misses[:5]

    print(f"{len(candidates)} eligible shots total ({len(makes)} makes, {len(misses)} misses) "
          f"across {len({c['game_id'] for c in candidates})} hosted games.")
    print(f"Sampled {len(sample)} shots ({len(makes[:5])} makes, {len(misses[:5])} misses).")
    for s in sample:
        print(f"  {s['shooter']:<8} {'make' if s['made'] else 'miss':<4} "
              f"game={s['game_id']} local_t={s['video_time_local']:.1f}s")

    OUT_PATH.write_text(json.dumps(sample, indent=2))
    print(f"\nWrote {OUT_PATH}")


if __name__ == "__main__":
    main()
