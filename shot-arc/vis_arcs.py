"""Draws each auto-detected flight over its own video frames so the fit can be checked by eye:
tracked ball positions (green), the fitted arc (yellow), and the fitted position on each shown
frame (red ring). One image per shot, four frames from the start to the end of the detected range.
Usage: python vis_arcs.py OUT_DIR [shot_key ...]   (no keys = every usable shot in the refit)"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from run_pipeline import fit_shot, FPS

HERE = Path(__file__).parent
H = 2160


def render(key, out_dir):
    tracked = json.loads((HERE / f"{key}-tracked.json").read_text(encoding="utf-8"))
    fit = fit_shot(tracked, H, key)
    if not fit.get("usable"):
        return None
    lo, hi = fit["frame_range"]
    pts = [(i, f["x"], f["y"]) for i, f in enumerate(tracked["frames"]) if "x" in f and lo <= i + 1 <= hi]
    t = np.array([i / FPS for i, _, _ in pts])
    xs = np.array([x for _, x, _ in pts])
    ys = np.array([H - y for _, _, y in pts])
    py = np.polyfit(t, ys, 2)
    px = np.polyfit(t, xs, 1)
    tt = np.linspace(t.min(), t.max(), 60)
    arc = [(float(np.polyval(px, u)), float(H - np.polyval(py, u))) for u in tt]

    allx = [p[0] for p in arc] + list(xs)
    ally = [p[1] for p in arc] + list(H - ys)
    pad = 260
    box = (int(max(0, min(allx) - pad)), int(max(0, min(ally) - pad)), int(min(3840, max(allx) + pad)), int(min(H, max(ally) + pad)))
    frames_dir = HERE / "frames" / key
    picks = [lo + round((hi - lo) * k / 3) for k in range(4)]
    tiles = []
    for fno in picks:
        img = Image.open(frames_dir / f"frame_{fno:04d}.png").convert("RGB")
        d = ImageDraw.Draw(img)
        d.line(arc, fill=(255, 220, 0), width=6)
        for _, x, y in pts:
            d.ellipse((x - 9, y - 9, x + 9, y + 9), outline=(0, 255, 90), width=4)
        u = (fno - 1) / FPS
        fx, fy = float(np.polyval(px, u)), float(H - np.polyval(py, u))
        d.ellipse((fx - 26, fy - 26, fx + 26, fy + 26), outline=(255, 40, 40), width=6)
        crop = img.crop(box)
        scale = 640 / crop.width
        tiles.append(crop.resize((640, max(1, int(crop.height * scale)))))
    th = max(t_.height for t_ in tiles)
    sheet = Image.new("RGB", (1280, th * 2), (20, 20, 20))
    for n, tile in enumerate(tiles):
        sheet.paste(tile, ((n % 2) * 640, (n // 2) * th))
    path = Path(out_dir) / f"{key}.png"
    sheet.save(path)
    return path, fit, picks


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    keys = sys.argv[2:] or [p.name[:-len("-tracked.json")] for p in sorted(HERE.glob("real_*-tracked.json"))]
    for k in keys:
        try:
            r = render(k, out)
        except FileNotFoundError:
            continue
        if r:
            print(k, r[1]["frame_range"], "frames shown", r[2], "flight", r[1]["flight_duration_s"])
