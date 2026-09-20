"""Does the fine-tuned detector's confidence actually separate the ball from the decoys?

The original detector scores the ball around 0.1, so the tracker had to accept its top detection at
any confidence, and it parked on posts and rims whenever the ball wasn't visible. The fine-tuned
model scores the ball much higher, which would let the tracker reject weak detections and report
"lost" instead. That only works if decoys score clearly lower than the ball. This measures it on the
validation images: for each candidate confidence threshold, how often the ball is still found
(ball images where the best detection is on the ball and clears the threshold) against how often a
decoy image (posts, ladder, rims, no ball) still produces a detection that clears it.

Run from the training package folder:   python conf_separation.py runs/ball/weights/best.pt"""
import sys
from pathlib import Path

from PIL import Image
from ultralytics import YOLO

HERE = Path(__file__).parent
VAL = HERE / "balldata_local"
TOLERANCE_PX = 35
THRESHOLDS = [0.05, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70]


def scores(weights):
    model = YOLO(str(weights))
    ball_conf, decoy_conf = [], []
    for img_path in sorted((VAL / "images" / "val").glob("*.jpg")):
        label = (VAL / "labels" / "val" / f"{img_path.stem}.txt").read_text().split()
        w, h = Image.open(img_path).size
        r = model.predict(str(img_path), verbose=False, conf=0.001, imgsz=640)[0]
        boxes = sorted(r.boxes, key=lambda b: -float(b.conf[0]))
        if not label:
            decoy_conf.append(float(boxes[0].conf[0]) if boxes else 0.0)
            continue
        tx, ty = float(label[1]) * w, float(label[2]) * h
        top = boxes[0] if boxes else None
        on_ball = top is not None and ((float((top.xyxy[0][0] + top.xyxy[0][2]) / 2) - tx) ** 2 + (float((top.xyxy[0][1] + top.xyxy[0][3]) / 2) - ty) ** 2) ** 0.5 <= TOLERANCE_PX
        ball_conf.append(float(top.conf[0]) if on_ball else 0.0)
    return ball_conf, decoy_conf


def table(name, ball, decoy):
    print(f"\n{name}   ({len(ball)} ball images, {len(decoy)} decoy images)")
    print(f"  {'threshold':>9}  {'ball kept':>10}  {'decoy false alarms':>19}")
    for t in THRESHOLDS:
        kept = sum(c >= t for c in ball) / max(len(ball), 1)
        fa = sum(c >= t for c in decoy) / max(len(decoy), 1)
        print(f"  {t:>9.2f}  {100 * kept:>9.0f}%  {100 * fa:>18.0f}%")
    ds = sorted(decoy)
    if ds:
        print(f"  decoy top-detection confidence: median {ds[len(ds) // 2]:.2f}, 90th percentile {ds[int(len(ds) * 0.9)]:.2f}, max {ds[-1]:.2f}")


if __name__ == "__main__":
    new = sys.argv[1] if len(sys.argv) > 1 else str(HERE / "runs" / "ball" / "weights" / "best.pt")
    table("ORIGINAL", *scores(HERE / "poolvision-ball-best.pt"))
    table("FINE-TUNED", *scores(new))
    print("\nA good threshold keeps most balls while letting almost no decoys through. If no threshold does,")
    print("confidence alone can't stop the tracker parking on decoys and the decoy examples need work.")
