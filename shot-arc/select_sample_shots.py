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

# Adam's real 4K60 handoff (see FINDINGS.md): each file is the full, unedited session recording,
# not trimmed per game the way game-videos/*.mp4 is. Confirmed by pulling the frame at a game's
# own videoTime from both the compressed per-game .mp4 (at videoTime - videoStart) and the 4K
# file (at videoTime directly, no offset) for two different games/files and checking they show
# the exact same instant -- the 4K file's own t=0 is the same reference point as videoTime, no
# separate offset needed. Games not listed here fall back to the compressed .mp4 as before.
FOURK_ROOT = Path(r"C:\Users\breso\Videos\pool-league-4k60")
GAME_4K_SOURCE = {
    "jmyhhago9gvrteb": FOURK_ROOT / "IMG_2482.MOV",
    "wurjg3g9xhehuka": FOURK_ROOT / "IMG_2483.MOV",
    "ctqc73n67cph45y": FOURK_ROOT / "IMG_2769.MOV",
    "spqwa4x7i5ylpdx": FOURK_ROOT / "IMG_2769.MOV",
    "5gqbi2wxew52g5p": FOURK_ROOT / "IMG_2769.MOV",
    "w2gvgk88n6e4had": FOURK_ROOT / "IMG_2770.MOV",
    "g7ko31w6njargwe": FOURK_ROOT / "IMG_2770.MOV",
    "cmgf3z9rea2l7rc": FOURK_ROOT / "IMG_2932.MOV",
    "bl46f6scpfe9ib6": FOURK_ROOT / "IMG_2932.MOV",
    "yf7wfx0jbtzy468": FOURK_ROOT / "IMG_2932.MOV",
}


def load_game_video_files():
    text = VIEWER_VIDEOS_JS.read_text(encoding="utf-8")
    # Rows look like: "gameId": { file: "game-videos/gameId.mp4", videoStart: 1648.520637 },
    rows = re.findall(r'"([a-z0-9]+)":\s*\{\s*file:\s*"([^"]+)",\s*videoStart:\s*([\d.]+)\s*\}', text)
    return {gid: {"file": file, "videoStart": float(start)} for gid, file, start in rows}


# Minimum gap (seconds) from ANY other scoring event in the same game right before this one.
# Added after real hand-labeling caught a sample ("00_Adam_make") that turned out to be a
# putback: Adam missed, Ian rebounded, Ian passed back to Adam, Adam scored -- two connected
# plays 6.8s apart, not one clean shot. No window size can fix that, since the "shot" itself is
# really a two-possession scramble; a single parabola fit was never going to describe it. Checking
# all 10 original samples this way found 3 of 10 had the same issue (00, 02, 05) -- common enough
# to filter at selection time rather than catch one at a time through hand-labeling.
CLEAN_SHOT_GAP_SECONDS = 8


def find_clean_candidates():
    """Every real logged field goal that's a clean, isolated possession (see
    CLEAN_SHOT_GAP_SECONDS) with a locally hosted video to pull frames from. Shared by this
    script's own small prototype sample and run_pipeline.py's larger real run, so both draw from
    exactly the same eligibility rules."""
    state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    hosted = load_game_video_files()
    players = {p["id"]: p["name"] for p in state["players"]}

    candidates = []
    for game in state["games"]:
        gid = game["id"]
        if gid not in hosted:
            continue
        fourk_path = GAME_4K_SOURCE.get(gid)
        if fourk_path is not None and fourk_path.exists():
            video_path = fourk_path
            use_4k = True
        else:
            video_path = GAME_VIDEOS_DIR / Path(hosted[gid]["file"]).name
            use_4k = False
        if not video_path.exists():
            continue
        all_events = game.get("scoringEvents", [])
        for ev in all_events:
            if ev.get("videoTime") is None:
                continue
            if ev.get("points") not in (2, 3):
                continue
            if not ev.get("shotLocation"):
                continue
            # The 4K file is the untrimmed session recording, so its own t=0 is the same
            # reference point as videoTime already -- no videoStart subtraction needed there.
            local_time = ev["videoTime"] if use_4k else ev["videoTime"] - hosted[gid]["videoStart"]
            if local_time < 2:  # need room for the pre-release window
                continue
            # Skip anything preceded within CLEAN_SHOT_GAP_SECONDS by another scoring event in
            # this same game -- a rebound/putback/scramble signature, not an isolated possession.
            preceded_recently = any(
                other is not ev and other.get("videoTime") is not None
                and 0 < ev["videoTime"] - other["videoTime"] <= CLEAN_SHOT_GAP_SECONDS
                for other in all_events
            )
            if preceded_recently:
                continue
            candidates.append({
                "game_id": gid,
                "video_file": str(video_path),
                "source": "4k" if use_4k else "compressed",
                "shooter": players.get(ev.get("scorerId"), "?"),
                "made": ev.get("made") is not False,
                "points": ev["points"],
                "video_time_abs": ev["videoTime"],
                "video_time_local": local_time,
                "shot_location": ev["shotLocation"],
            })
    return candidates


def main():
    candidates = find_clean_candidates()
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
