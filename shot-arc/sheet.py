"""Contact sheet for one shot: 12 frames across its whole window with the tracker's position marked
(red ring), so a failing shot can be judged by eye: is the shot in the window, is the ball visible,
and is the tracker actually on it? Usage: python sheet.py OUT_DIR shot_key [shot_key ...]"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent


def sheet(key, out_dir, n=12, tile_w=480):
    tracked = json.loads((HERE / f"{key}-tracked.json").read_text(encoding="utf-8"))["frames"]
    total = len(tracked)
    picks = [round(k * (total - 1) / (n - 1)) for k in range(n)]
    scale = tile_w / 3840
    tiles = []
    for i in picks:
        img = Image.open(HERE / "frames" / key / f"frame_{i + 1:04d}.png").convert("RGB")
        img = img.resize((tile_w, int(2160 * scale)))
        d = ImageDraw.Draw(img)
        f = tracked[i]
        if "x" in f:
            x, y = f["x"] * scale, f["y"] * scale
            d.ellipse((x - 9, y - 9, x + 9, y + 9), outline=(255, 30, 30), width=3)
        d.text((6, 4), f"t={i / 30:.1f}s", fill=(255, 255, 0))
        tiles.append(img)
    th = tiles[0].height
    out = Image.new("RGB", (tile_w * 4, th * 3))
    for k, t in enumerate(tiles):
        out.paste(t, ((k % 4) * tile_w, (k // 4) * th))
    path = Path(out_dir) / f"sheet_{key}.png"
    out.save(path)
    return path


if __name__ == "__main__":
    for k in sys.argv[2:]:
        print(sheet(k, sys.argv[1]))
