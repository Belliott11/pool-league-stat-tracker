BALL DETECTOR TRAINING PACKAGE
==============================
What this is: about 1,200 cropped frames from our own pool footage where the ball's position was
confirmed by eye, plus empty images of things the detector mistakes for the ball (volleyball-stand
posts, the ladder, rims). It fine-tunes Adam's detector (poolvision-ball-best.pt) so it finds the
ball more reliably on this footage. Validation is whole shots the training never sees.

1. One-time setup (Python 3.10 or newer):
     pip install ultralytics
   If the train script says "No GPU visible to PyTorch", install the GPU build of PyTorch first
   (pick the CUDA version for your card at pytorch.org, for example):
     pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
   then run:  python -c "import torch; print(torch.cuda.is_available())"   (should print True)

2. Train (from inside this folder):
     python train_ball.py
   About 60 epochs. On a modern GPU expect minutes, not hours. If it runs out of GPU memory:
     python train_ball.py --batch 8

3. Check it worked (compares the original and the new model on unseen shots):
     python eval_ball.py runs/ball/weights/best.pt

4. Copy the result back. The one file that matters is:
     runs/ball/weights/best.pt
   Put it in the project at:  shot-arc/adam-balldata/poolvision-ball-finetuned.pt
   (or just send me the path) and I'll re-run the tracking with it.

Nothing here modifies the original weights.
