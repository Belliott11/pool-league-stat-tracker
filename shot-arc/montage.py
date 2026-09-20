"""Eight accepted arcs per image, one tile each, for checking many shots quickly: the fitted arc
(yellow), tracked points (green), start (blue) and end (magenta) of the flight, and a red ring at
the fitted ball position on the middle frame of the flight. Skips shots listed in verified.txt.
Usage: python montage.py OUT_DIR"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from hoops import rim_centers
from run_pipeline import fit_shot, FPS

HERE = Path(__file__).parent
H = 2160
TILE_W = 640


def tile(key):
    tracked = json.loads((HERE / f"{key}-tracked.json").read_text(encoding="utf-8"))
    rims = rim_centers(json.loads((HERE / f"{key}-hoops.json").read_text()))
    fit = fit_shot(tracked, H, key, rims)
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
    img = Image.open(HERE / "frames" / key / f"frame_{mid:04d}.png").convert("RGB")
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
    ImageDraw.Draw(crop).text((6, 4), key[5:], fill=(255, 255, 0))
    return crop


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    verified = set((HERE / "verified.txt").read_text().split()) if (HERE / "verified.txt").exists() else set()
    results = json.loads((HERE / "pipeline_results_refit.json").read_text())
    keys = [r["shot_key"] for r in results if r["fit"].get("usable") and r["shot_key"][5:] not in verified]
    tiles = [(k, tile(k)) for k in keys]
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
        path = out / f"montage_{n // 8 + 1}.png"
        sheet.save(path)
        print(path.name, [k[5:] for k, _ in chunk])


if __name__ == "__main__":
    main()
