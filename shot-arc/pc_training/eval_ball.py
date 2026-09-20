"""Compares the original detector with the fine-tuned one on the held-out validation shots (whole
shots the training never saw): how often the top detection lands on the real ball, how confident it
is there, and how often it fires on decoys (posts, ladder, rims) in the empty images.
Run:   python eval_ball.py runs/ball/weights/best.pt"""
import sys
from pathlib import Path

from PIL import Image
from ultralytics import YOLO

HERE = Path(__file__).parent
VAL = HERE / "balldata_local"
TOLERANCE_PX = 30  # a detection this close to the labelled center counts as on the ball


def evaluate(weights):
    model = YOLO(str(weights))
    on_ball = confident = total = 0
    conf_sum = 0.0
    false_pos = negatives = 0
    for img_path in sorted((VAL / "images" / "val").glob("*.jpg")):
        label = (VAL / "labels" / "val" / f"{img_path.stem}.txt").read_text().split()
        w, h = Image.open(img_path).size
        r = model.predict(str(img_path), verbose=False, conf=0.001, imgsz=640)[0]
        boxes = sorted(r.boxes, key=lambda b: -float(b.conf[0]))
        if not label:  # empty image: any confident detection is a false alarm
            negatives += 1
            if boxes and float(boxes[0].conf[0]) > 0.10:
                false_pos += 1
            continue
        total += 1
        tx, ty = float(label[1]) * w, float(label[2]) * h
        near = [b for b in boxes if ((b.xyxy[0][0] + b.xyxy[0][2]) / 2 - tx) ** 2 + ((b.xyxy[0][1] + b.xyxy[0][3]) / 2 - ty) ** 2 <= TOLERANCE_PX ** 2]
        if boxes and near and near[0] is boxes[0]:
            on_ball += 1  # the single best detection is on the ball
        if near:
            conf_sum += float(near[0].conf[0])
            if float(near[0].conf[0]) >= 0.25:
                confident += 1
    return {
        "top detection on the ball": f"{on_ball}/{total} ({100 * on_ball / max(total, 1):.0f}%)",
        "ball found at 0.25+ confidence": f"{confident}/{total} ({100 * confident / max(total, 1):.0f}%)",
        "average confidence on the ball": f"{conf_sum / max(total, 1):.2f}",
        "false alarms on empty images": f"{false_pos}/{negatives}",
    }


if __name__ == "__main__":
    new = sys.argv[1] if len(sys.argv) > 1 else str(HERE / "runs" / "ball" / "weights" / "best.pt")
    for name, path in (("ORIGINAL", HERE / "poolvision-ball-best.pt"), ("FINE-TUNED", new)):
        print(f"\n{name}")
        for k, v in evaluate(path).items():
            print(f"  {k:34} {v}")
