"""
Step 1 of the per-shot pipeline (see standalone-shot-arc-plan.md): pull frames from roughly
1.5-2s before a shot's videoTime through 0.5s after (release through landing), using ffmpeg
seeking the same way the existing dashboard already does for clip review.
"""
import subprocess
import shutil
from pathlib import Path

PRE_ROLL = 1.8
POST_ROLL = 0.6
FPS = 30  # matches typical source footage; frame-detection step doesn't need more than this

FRAMES_ROOT = Path(__file__).parent / "frames"


def extract_shot_frames(video_file: str, local_time: float, shot_key: str) -> Path:
    start = max(0.0, local_time - PRE_ROLL)
    duration = PRE_ROLL + POST_ROLL
    out_dir = FRAMES_ROOT / shot_key
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    # -ss before -i: fast seek to the nearest keyframe, then a short accurate decode from there.
    # A real pool video's keyframe interval can put "before -i" seeking off by a second or more,
    # which is why -ss appears a second time (after -i) too: the first does the coarse/fast jump,
    # the second trims the decoded output back to the exact intended start.
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", str(max(0.0, start - 2.0)), "-i", video_file,
        "-ss", "2.0", "-t", str(duration),
        "-vf", f"fps={FPS}",
        str(out_dir / "frame_%04d.png"),
    ]
    subprocess.run(cmd, check=True)
    frames = sorted(out_dir.glob("frame_*.png"))
    return out_dir, start, frames


if __name__ == "__main__":
    import json
    shots = json.loads((Path(__file__).parent / "sample_shots.json").read_text())
    for i, s in enumerate(shots):
        key = f"{i:02d}_{s['shooter']}_{'make' if s['made'] else 'miss'}"
        out_dir, start, frames = extract_shot_frames(s["video_file"], s["video_time_local"], key)
        print(f"{key}: {len(frames)} frames -> {out_dir} (clip starts at local t={start:.2f}s)")
