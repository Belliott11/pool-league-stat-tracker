# Shot-Arc Extraction — Prototype Findings

Ran the standalone build plan's own recommended first step: prototype ball detection against a
small handful of real shots (10, mixed makes/misses) before investing in the full pipeline across
all logged shots. Conclusion: **stock detection doesn't work well enough here to build on yet.**

## What was built and run

- `select_sample_shots.py` — pulls 10 real logged shots (5 makes, 5 misses) from the actual
  season data, using games that have a locally hosted video file and a real `videoTime`.
- `extract_frames.py` — ffmpeg frame extraction, 1.8s before to 0.6s after each shot's own
  timestamp, at 30fps (matches the plan's "release through landing" window).
- `detect_and_fit.py` — runs a pretrained YOLOv8 detector's "sports ball" class per frame, keeps
  the ball's center position where found, and fits a least-squares parabola to (time, height).

## Result: ball detection essentially fails on the real in-flight shots

- YOLOv8n (default 640px inference): **0/720 frames** across all 10 sampled shots had a
  "sports ball" detection, even at a very low 0.1 confidence threshold.
- YOLOv8n at full 1280px inference (keeps the ball from being downscaled away): still close to
  zero on most shots; a naive frame-count of 301/720 (41.8%) is **misleading** — it's dominated
  by one shot (08) where the same box, in the *exact same pixel location*, got flagged in nearly
  every single frame. That box turned out to be a real basketball — just a second, spare one
  sitting motionless in the grass off to the side, not the one actually in play. See
  `debug_falsepos.png`/`debug_crop.png` for the crops that showed this.
- YOLOv8x (the largest stock model, 130MB) found **zero** sports-ball detections on a shot where
  the ball is clearly visible to the human eye at release (see `contact_sheet.png`).

## What this means

The model can clearly recognize this exact ball's look under easy conditions (stationary, on
grass, decent size in frame) — it found the spare ball in the grass without trouble. It just
can't find the real ball once it's small, moving fast, and near/over water with glare, which is
exactly the harder case the build plan itself called out ("ball detection in a pool ... is
genuinely harder than on a dry court, which is part of why PoolVision's own fine-tuned model
exists in the first place").

## Recommendation

Don't build out the full pipeline (frame extraction + fit across all 363 logged shots) on top of
stock detection — a sub-1% real hit rate on in-flight shots isn't a usable signal, and chasing it
with an even bigger stock model (already tried yolov8x) doesn't move the needle. Two real paths
forward, both bigger asks than this prototype:

1. **Ask Adam** whether PoolVision's own already-fine-tuned pipeline keeps or could export the
   ball's tracked positions/fitted parabola internally, per the updated spec's own Part 2 framing
   ("does this already exist somewhere in memory, or would it take real work to add?"). If yes,
   that's a real shortcut — no local fine-tuning needed at all.
2. **Fine-tune a small detector** on hand-labeled frames from these actual games. Scoped
   narrowly (one class, a few hundred labeled frames from games already logged) this is a real
   but nontrivial project, not a quick follow-on to this prototype.

Not pursuing either without checking in first — this findings doc is the "worth confirming before
assuming this is easy" checkpoint the plan itself asked for.

## Update: release-point (wrist) tracking prototype — a much better result

Ran `pose_release.py` against the same 10-shot sample using stock `yolo11s-pose.pt` (no local
fine-tuning — see `POOLVISION-NOTES.md`: this is the one piece of PoolVision that works
un-fine-tuned). Tracked wrist height relative to shoulder width per detected person, per frame.

**Person + wrist keypoints detected in 720/720 sampled frames (100%)** — a complete reversal of
the ball-detection result above. Confirms PoolVision's own experience: people are easy for a
stock model on this camera; the ball is the hard part.

**But the per-shot "peak release height" numbers this run printed are not trustworthy yet.**
Spot-checked shot `01_Adam_make`'s series around its reported peak:

```
t=0.500  3.39
t=0.533  3.76
t=0.567  8.22
t=0.600  2.20
t=0.633  5.23
t=0.667  9.60
t=0.700  0.45
```

That's not one person's arm rising and falling — it's too noisy frame to frame. The script takes
the max wrist-height reading across *every* detected person in each frame, and with several
people in the pool, it's silently jumping between different people rather than following the
shooter. This is exactly the problem PoolVision's own `shooter.py` spends real effort solving
(matching a person to the ball's release point, cap-color voting across frames) — a problem this
prototype hasn't attempted, since it has no ball-tracking or cap-color logic to anchor on.

**Real next step, not yet done:** track one consistent person across the window (simple
frame-to-frame nearest-box matching would remove the identity-swapping noise) and pick that person
using some anchor — ball-track proximity if the ball detector ever works, a hand-labeled shooter
box (the labeling tool could be extended for this), or a per-game calibrated hoop-proximity
heuristic. Not attempted here — flagging it rather than presenting noisy numbers as real.

## Files (prototype only, not wired into the app)

All local to `shot-arc/`. `frames/`, `*.pt` (model weights), `*.png` (including the debug crops
referenced above), and the JSON outputs are gitignored (large, fully regenerable locally by
re-running the three scripts in order) — only this findings doc and the three pipeline scripts
themselves are tracked in git.
