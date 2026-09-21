"""Contact sheets for the arcs the PC's fine-tuned detector found that the laptop's set does not have,
so they can be checked by eye before joining shot_arcs.csv. Reads ft_full/ (tracked, hoops, the
refit results) and grabs just the middle frame of each flight straight from the 4K source.
Same drawing as montage.py: fitted arc (yellow), tracked points (green), start (blue), end (magenta),
red ring at the fitted ball position on the shown frame.
Usage: python ft_montage.py OUT_DIR [keys.json]   (default keys: ft_full/pc_only_keys.json)"""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from hoops import rim_centers
from run_pipeline import FPS, fit_shot
from select_sample_shots import GAME_4K_SOURCE

HERE = Path(__file__).parent
FT = HERE / os.environ.get("SHOTARC_FT", "ft_full")   # which PC results folder (ft_full, ft_full_v3)
H = 2160
TILE_W = 640
PRE_ROLL = 1.0


def grab_frame(game, t, out):
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", str(GAME_4K_SOURCE[game]),
                    "-frames:v", "1", str(out)], check=True)


def tile(key, fit_row):
    tracked = json.loads((FT / f"real_{key}-tracked.json").read_text(encoding="utf-8"))
    rims = rim_centers(json.loads((FT / f"real_{key}-hoops.json").read_text()))
    fit = fit_shot(tracked, H, f"real_{key}", rims)
    if not fit.get("usable"):
        return None
    lo, hi = fit["frame_range"]
    pts = [(i, f["x"], f["y"]) for i, f in enumerate(tracked["frames"]) if "x" in f and lo <= i + 1 <= hi]
    t = np.array([i / FPS for i, _, _ in pts])
    xs = np.array([x for _, x, _ in pts])
    ys = np.array([H - y for _, _, y in pts])
    py, px = np.polyfit(t, ys, 2), np.polyfit(t, xs, 1)
    tt = np.linspace(t.min(), t.max(), 60)
    arc = [(float(np.polyval(px, u)), float(H - np.polyval(py, u))) for u in tt]
    allx = [p[0] for p in arc] + list(xs)
    ally = [p[1] for p in arc] + list(H - ys)
    pad = 300
    box = (int(max(0, min(allx) - pad)), int(max(0, min(ally) - pad)), int(min(3840, max(allx) + pad)), int(min(H, max(ally) + pad)))
    mid = (lo + hi) // 2
    game = key.split("_")[0]
    t_abs = fit_row["video_time_abs"] - PRE_ROLL + (mid - 1) / FPS
    frame_path = FT / "mid_frames" / f"{key}.png"
    frame_path.parent.mkdir(exist_ok=True)
    if not frame_path.exists():
        grab_frame(game, t_abs, frame_path)
    img = Image.open(frame_path).convert("RGB")
    d = ImageDraw.Draw(img)
    d.line(arc, fill=(255, 220, 0), width=7)
    for _, x, y in pts:
        d.ellipse((x - 9, y - 9, x + 9, y + 9), outline=(0, 255, 90), width=4)
    d.ellipse((arc[0][0] - 24, arc[0][1] - 24, arc[0][0] + 24, arc[0][1] + 24), fill=(60, 120, 255))
    d.ellipse((arc[-1][0] - 24, arc[-1][1] - 24, arc[-1][0] + 24, arc[-1][1] + 24), fill=(255, 40, 220))
    u = (mid - 1) / FPS
    fx, fy = float(np.polyval(px, u)), float(H - np.polyval(py, u))
    d.ellipse((fx - 30, fy - 30, fx + 30, fy + 30), outline=(255, 40, 40), width=7)
    crop = img.crop(box)
    crop = crop.resize((TILE_W, max(1, int(crop.height * TILE_W / crop.width))))
    ImageDraw.Draw(crop).text((6, 4), key, fill=(255, 255, 0))
    return crop


def key_of(r):
    whole, frac = f"{r['video_time_abs']:.3f}".split(".")
    return f"{r['game_id']}_{whole}_{frac}"


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    keys = json.loads(Path(sys.argv[2] if len(sys.argv) > 2 else FT / "pc_only_keys.json").read_text())
    rows = {}
    for name in sorted(p.name for p in FT.glob("pipeline_results_ft*.json")):
        for r in json.loads((FT / name).read_text(encoding="utf-8")):
            rows[key_of(r)] = r
    tiles = [(k, tile(k, rows[k])) for k in keys]
    tiles = [(k, t) for k, t in tiles if t is not None]
    for n in range(0, len(tiles), 8):
        chunk = tiles[n:n + 8]
        row_h = [max(t.height for _, t in chunk[i:i + 2]) for i in range(0, len(chunk), 2)]
        sheet = Image.new("RGB", (TILE_W * 2, sum(row_h)), (20, 20, 20))
        y = 0
        for r, i in enumerate(range(0, len(chunk), 2)):
            for c, (_, t) in enumerate(chunk[i:i + 2]):
                sheet.paste(t, (c * TILE_W, y))
            y += row_h[r]
        path = out / f"ft_montage_{n // 8 + 1}.png"
        sheet.save(path)
        print(path.name, [k for k, _ in chunk])


if __name__ == "__main__":
    main()
