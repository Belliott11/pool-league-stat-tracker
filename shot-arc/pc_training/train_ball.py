"""Fine-tunes the ball detector on ball positions verified by eye from our own footage.
Run from inside this folder:   python train_ball.py
Uses the GPU automatically when PyTorch can see one, otherwise falls back to CPU (slow)."""
import argparse
from pathlib import Path

import torch
from ultralytics import YOLO

HERE = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=str(HERE / "poolvision-ball-best.pt"), help="starting weights")
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=16, help="lower to 8 if the GPU runs out of memory")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--name", default="ball")
    args = ap.parse_args()

    if torch.cuda.is_available():
        device = 0
        print("Training on GPU:", torch.cuda.get_device_name(0))
    else:
        device = "cpu"
        print("No GPU visible to PyTorch, training on CPU (this will be slow). See README.txt.")

    # data.yaml written fresh with this machine's absolute path, so the folder can live anywhere.
    data_yaml = HERE / "data_abs.yaml"
    data_yaml.write_text(
        f"path: {(HERE / 'balldata_local').as_posix()}\ntrain: images/train\nval: images/val\nnames:\n  0: ball\n"
    )

    model = YOLO(args.weights)
    model.train(
        data=str(data_yaml), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch, device=device,
        workers=4, project=str(HERE / "runs"), name=args.name, exist_ok=True,
        optimizer="AdamW", lr0=0.0005, cos_lr=True, warmup_epochs=2, patience=20,
        # The ball is small and the pool scenes are near-symmetric, so flips are safe; keep scale
        # changes modest since camera zoom barely varies inside a recording.
        fliplr=0.5, flipud=0.2, scale=0.3, translate=0.1, mosaic=0.5, close_mosaic=8,
    )
    best = HERE / "runs" / args.name / "weights" / "best.pt"
    print("\nDone. Best weights:", best)


if __name__ == "__main__":
    main()
