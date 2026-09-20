"""Compares the original detector with the fine-tuned one on the held-out validation shots (whole
shots the training never saw).

The frames are split by how the ORIGINAL detector does on them, because that is the question:
  * "easy": the original's single best detection is already on the ball.
  * "hard": it isn't (it ranks something else first, or gives nothing near the ball). These are the
    frames the old detector struggles with, and they are the real test: a fine-tune that only gets
    more confident on easy frames hasn't closed the gap that matters.
For each group, for each model: how often the single best detection lands on the ball, how often
the ball is found at 0.25+ confidence, and the average confidence on the ball. Also how often each
model fires on decoys (posts, ladder, rims) in the empty images.
Run:   python eval_ball.py runs/ball/weights/best.pt"""
import sys
from pathlib import Path

from PIL import Image
from ultralytics import YOLO

HERE = Path(__file__).parent
VAL = HERE / "balldata_local"
TOLERANCE_PX = 35  # a detection this close to the labelled center counts as on the ball


def run(weights):
    model = YOLO(str(weights))
    balls, empties = {}, {"false_pos": 0, "n": 0}
    for img_path in sorted((VAL / "images" / "val").glob("*.jpg")):
        label = (VAL / "labels" / "val" / f"{img_path.stem}.txt").read_text().split()
        w, h = Image.open(img_path).size
        r = model.predict(str(img_path), verbose=False, conf=0.001, imgsz=640)[0]
        boxes = sorted(r.boxes, key=lambda b: -float(b.conf[0]))
        if not label:
            empties["n"] += 1
            if boxes and float(boxes[0].conf[0]) > 0.10:
                empties["false_pos"] += 1
            continue
        tx, ty = float(label[1]) * w, float(label[2]) * h

        def dist(b):
            bx = float((b.xyxy[0][0] + b.xyxy[0][2]) / 2)
            by = float((b.xyxy[0][1] + b.xyxy[0][3]) / 2)
            return ((bx - tx) ** 2 + (by - ty) ** 2) ** 0.5

        near = [b for b in boxes if dist(b) <= TOLERANCE_PX]
        balls[img_path.stem] = {
            "top": bool(boxes and near and near[0] is boxes[0]),
            "conf": float(near[0].conf[0]) if near else 0.0,
        }
    return balls, empties


def summarize(balls, stems):
    n = max(len(stems), 1)
    top = sum(balls[s]["top"] for s in stems)
    conf25 = sum(balls[s]["conf"] >= 0.25 for s in stems)
    avg = sum(balls[s]["conf"] for s in stems) / n
    return f"best detection on ball {100 * top / n:.0f}%   found at 0.25+ {100 * conf25 / n:.0f}%   avg conf {avg:.2f}"


if __name__ == "__main__":
    new_path = sys.argv[1] if len(sys.argv) > 1 else str(HERE / "runs" / "ball" / "weights" / "best.pt")
    old_balls, old_empty = run(HERE / "poolvision-ball-best.pt")
    new_balls, new_empty = run(new_path)
    easy = [s for s, v in old_balls.items() if v["top"]]
    hard = [s for s, v in old_balls.items() if not v["top"]]
    print(f"\n{len(old_balls)} validation ball frames: {len(easy)} easy (original already ranks the ball first), {len(hard)} hard (it doesn't)")
    for label, stems in (("ALL FRAMES", list(old_balls)), ("EASY FRAMES", easy), ("HARD FRAMES  <- the real test", hard)):
        print(f"\n{label} (n={len(stems)})")
        print(f"  original    {summarize(old_balls, stems)}")
        print(f"  fine-tuned  {summarize(new_balls, stems)}")
    print(f"\nFalse alarms on empty decoy images (best detection above 0.10 confidence, out of {old_empty['n']}):")
    print(f"  original    {old_empty['false_pos']}")
    print(f"  fine-tuned  {new_empty['false_pos']}")
