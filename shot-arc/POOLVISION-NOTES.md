# What PoolVision's own source code says (read directly, not asked of Adam)

Adam added Ben as a collaborator on `poolvision` and `poolean`; cloned locally to
`C:\Users\breso\poolvision` for reference (not modified, not pushed to -- it's his repo). Answers
three open questions from the updated video-backed dev spec by reading the actual code.

## 1. Does the ball's tracked arc get persisted, or thrown away? (Part 2's actual ask)

**Persisted.** `src/arc.py` is exactly the parabola fit described in the spec (`fit_xy`,
`best_arc`, `release`) -- least-squares, x linear in t, y quadratic in t, same idea as
`standalone-shot-arc-plan.md`. `src/attribute.py` calls it, and its result (`arcPct`, `arcRms`,
`arcSpan`, `arcSag`, the release point, a per-frame polyline of the fitted curve) gets written
straight to `out/attribute_<video>.json`, one row per shot, alongside the shooter attribution
itself. Nothing needs to be added to PoolVision for this -- the data already exists in its output
files today. The real remaining work is just the join: matching PoolVision's `video` + `clock`
fields against Poolean's own `game` + `videoTime` + `shooter` + `made`, the same key already
planned.

## 2. What detection approach does PoolVision actually use for the ball?

**A fine-tuned YOLO11s, not stock.** `src/balltrain.py`'s own docstring says why directly:
"COCO's 'sports ball' is a generic class trained on clean photographs of balls. This pool's ball
is wet, motion-blurred, half-inside a net, against skin or turquoise water... A model that has
seen a few hundred of those is a different proposition." Trained from COCO weights (not from
scratch) on ~323 hand-labeled images of this exact ball, 80 epochs, imgsz 640, CPU, batch 8,
patience 15 (early stop).

This confirms the standalone prototype's own finding (`FINDINGS.md`): stock detection failing was
expected, not a sign of a flawed approach. It also hands over a concrete recipe -- YOLO11s from
COCO weights, ~300+ labeled images, that exact training config -- if a local fine-tune is the
path taken. Re-tested the standalone prototype's failing shot with a tight, upscaled crop around
the hoop (the trick that PoolVision's own pose model needed -- see #3) in case that alone would
fix it: still zero "sports ball" detections. Confirms ball detection is architecturally the harder
piece even in PoolVision's own analysis -- cropping fixed the *pose* model, not the ball model,
which is exactly why `balltrain.py` exists as a separate real fine-tuning step.

## 3. Is the wrist/pose logic reusable, or does it need building from scratch?

**Directly reusable, no fine-tuning needed.** `src/shooter.py` and `src/facing.py` both run
stock, off-the-shelf `yolo11s-pose.pt` (standard Ultralytics COCO-17 keypoints -- left/right wrist
are keypoints 9/10, same as any other YOLO-pose model). No `posetrain.py` or equivalent exists
anywhere in the repo -- unlike the ball, pose detection just works well enough stock on this exact
camera and pool. The one real trick: crop tightly around a known region before running it (a
1500x1100 window around the ball's last position, at native 4K, `imgsz=1280`) rather than running
on the full frame -- the code's own comment calls this "the same move that took the ball detector
from useless to 60-for-60: the model was never the problem, the search area was" (for the *pose*
model in that spot; the ball model still needed real fine-tuning on top of the same trick, per
#2 above).

For Part 3 (release-point tracking): this means no local model training is needed at all, just
`yolo11s-pose.pt` (or an equivalent MediaPipe/YOLO-pose model) run on a tight crop around each
already-known shot's own `shotLocation`, reading keypoints 9/10 for wrist position relative to
keypoint 0 (nose) or the shoulder keypoints (5/6) for "release height relative to shoulder," per
the spec's own scoped ask. A real prototype of this (mirroring the standalone shot-arc one) is a
much smaller lift than the ball detector was, precisely because this piece doesn't need
fine-tuning first.
