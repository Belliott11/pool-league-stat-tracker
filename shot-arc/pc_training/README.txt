BALL DETECTOR TRAINING PACKAGE
==============================
What this is: about 1,500 cropped frames from our own pool footage inside flights that were
confirmed by eye (the ball's position is where the old detector found it, checked against the
flight), plus about 300 empty images of things the detector mistakes for the ball (volleyball-stand
posts, the ladder, rims). It fine-tunes Adam's detector (poolvision-ball-best.pt) so it ranks the
ball first more reliably on this footage. Validation is whole shots the training never sees.

Honest limit: these are frames the old detector already found the ball in (only 6 short gaps were
filled by interpolation, because these flights have almost no gaps). Shots where the tracker never
found the ball aren't in the set, since nobody has confirmed where the ball is there. So expect it
to get better at ranking the ball first and at ignoring decoys, not to solve the hard shots.

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

3. Check it worked (compares the original and the new model on unseen shots). The line to watch is
   "HARD FRAMES", the ones where the original didn't rank the ball first. If the fine-tuned model
   doesn't improve there, it has only become more confident on easy frames.
     python eval_ball.py runs/ball/weights/best.pt

4. Copy the result back. The one file that matters is:
     runs/ball/weights/best.pt
   Put it in the project at:  shot-arc/adam-balldata/poolvision-ball-finetuned.pt
   (or just send me the path) and I'll re-run the tracking with it.

Nothing here modifies the original weights.
