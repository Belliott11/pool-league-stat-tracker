"""Draws every tracked ball position of chosen PC-run shots onto one frame (colored by time: blue early,
red late) so it is clear what the detector followed when no shot flight could be fitted.
Usage: python ft_tracks.py OUT.png KEY [KEY ...]   (keys like cmgf3z9rea2l7rc_1644_468)"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

from select_sample_shots import GAME_4K_SOURCE

HERE = Path(__file__).parent
FT = HERE / "ft_full"
FPS = 30
PRE_ROLL = 1.0
TILE_W = 900


def tile(key):
    tracked = json.loads((FT / f"real_{key}-tracked.json").read_text(encoding="utf-8"))["frames"]
    pts = [(i, f["x"], f["y"], f.get("conf", 0)) for i, f in enumerate(tracked) if "x" in f]
    game, whole, frac = key.rsplit("_", 2)
    t0 = float(f"{whole}.{frac}") - PRE_ROLL
    mid_i = pts[len(pts) // 2][0] if pts else 90
    frame = FT / "mid_frames" / f"{key}_track.png"
    frame.parent.mkdir(exist_ok=True)
    if not frame.exists():
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{t0 + mid_i / FPS:.3f}", "-i",
                        str(GAME_4K_SOURCE[game]), "-frames:v", "1", str(frame)], check=True)
    img = Image.open(frame).convert("RGB")
    d = ImageDraw.Draw(img)
    for i, x, y, c in pts:
        u = i / 179
        col = (int(255 * u), 60, int(255 * (1 - u)))
        d.ellipse((x - 14, y - 14, x + 14, y + 14), outline=col, width=5)
    if pts:
        xs = [p[1] for p in pts]; ys = [p[2] for p in pts]
        box = (int(max(0, min(xs) - 400)), int(max(0, min(ys) - 300)), int(min(3840, max(xs) + 400)), int(min(2160, max(ys) + 300)))
    else:
        box = (0, 0, 3840, 2160)
    crop = img.crop(box)
    crop = crop.resize((TILE_W, max(1, int(crop.height * TILE_W / crop.width))))
    ImageDraw.Draw(crop).text((6, 4), f"{key} ({len(pts)} detections, frames {pts[0][0] if pts else '-'}-{pts[-1][0] if pts else '-'})", fill=(255, 255, 0))
    return crop


def main():
    tiles = [tile(k) for k in sys.argv[2:]]
    row_h = [max(t.height for t in tiles[i:i + 2]) for i in range(0, len(tiles), 2)]
    sheet = Image.new("RGB", (TILE_W * 2, sum(row_h)), (20, 20, 20))
    y = 0
    for r, i in enumerate(range(0, len(tiles), 2)):
        for c, t in enumerate(tiles[i:i + 2]):
            sheet.paste(t, (c * TILE_W, y))
        y += row_h[r]
    sheet.save(sys.argv[1])


if __name__ == "__main__":
    main()
