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

### Follow-up: fixed the tracking bug, found a second one underneath it

`pose_release.py` now does real single-person tracking (greedy nearest-box matching across
frames, picking the track with the cleanest single rise-then-fall rather than the max across
everyone per frame). That removed the identity-swapping noise, but the peak numbers are *still*
not trustworthy: shot `01_Adam_make`'s now-correctly-tracked single-person series still jumps
`2.99 -> 5.0 -> 5.23 -> 9.6 -> 3.29` frame to frame, and 9.6 shoulder-widths above the shoulder
line isn't physically real for an arm. Root cause is almost certainly normalizing by shoulder
*width*: during the actual release/follow-through, a shooter often turns more face-on to the
hoop, foreshortening the shoulder-to-shoulder pixel distance toward zero — and dividing by a
small, noisy denominator blows up the ratio. Worth trying a more stable body-scale reference
(person bounding-box height, or nose-to-shoulder distance) instead of shoulder width, and/or
smoothing the series before reading off a peak. Not attempted yet.

## Checked: does Adam's own labeled ball-training data already exist somewhere accessible?

Now that repo access exists, searched both `poolvision` and `poolean` directly rather than
assuming. Findings:

- `poolvision/labels/` **is** committed, but it's shot-*outcome* ground truth (make/miss/behind
  calls, timestamps, confidence — `shots.csv`, `answerkey_*.json`, `judged.json`), not ball-
  position training data. Different kind of "label" entirely.
- The real ball-detection training set (`src/balldata.py`/`src/balltrain.py`, YOLO format:
  `images/{train,val}`, `labels/{train,val}`, `data.yaml`, 323 images) lives at `out/balldata/`
  on Adam's own machine. `out/` and `*.pt` are both gitignored ("regenerable" / weights). Not a
  live-database situation (unlike the earlier award-ballot case) — just local files that never
  got committed. Repo access alone doesn't surface it; asking Adam to export/zip that one folder
  would.
- `poolean` itself has nothing relevant, consistent with its own README's stated separation
  ("a Python project with torch, model weights and thousands of frames has no business inside
  it").

Two things worth knowing before asking for it:

1. **His labels aren't hand-drawn boxes.** `balldata.py`'s own docstring: fit a parabola to the
   frames where the stock detector *did* find the ball, then use the fitted curve to predict
   position in the frames it missed — exactly the hard cases (blurred, in the net, against skin).
   Self-bootstrapping from partial detections, not manual clicking through hundreds of frames.
2. **Likely root cause for our own ~0% stock-detection rate, found in his own comment:** he crops
   to 960px around the region of interest *before* detection, not the full frame — "puts a 35px
   ball at ~4% of the frame, against 0.9% in a 3840-wide frame downscaled to 1280." Our pipeline
   fed the detector the full 1280x720 frame, landing almost exactly in his stated bad case.
   **Worth trying a tight crop around the hoop before detection on our own footage — actionable
   now, independent of getting anything from Adam.**

**Tried the crop idea on one shot already, inconclusive**: cropped `00_Adam_make`'s frames to a
hand-picked hoop-region box and re-ran stock detection there vs. full-frame. Full-frame: 1/72
hits; cropped: 0/72. Doesn't confirm the crop theory, but doesn't rule it out either — a single
fixed crop box for the whole clip is fragile (the play moves around; a shooter well away from the
hoop falls outside a hoop-centered box, and my box was hand-eyeballed, not computed), so this
isn't a fair test yet. A real test needs a crop that tracks the action (e.g. around the pose
tracker's own person box from the Part 3 prototype above) rather than one static region.

Combining his 323 labeled images (different camera/pool/lighting) with our own would likely
generalize better than either alone (same physical object, different conditions is a real,
well-established benefit for training a small detector), but his 4K/different-angle data
probably doesn't fully replace labeling some of our own 1280x720 footage on top.

## Real hand-labeling: first shot done, found (and fixed) a window-calibration bug

Ben labeled `02_Evan_make` by hand through the new tool (51/72 frames). Sanity-checked the result
by fitting a parabola to the real clicked positions rather than assuming the tool worked: the
fitted curve opened the wrong way (upward, `a=40.5 > 0`) with an 18.6px RMS residual, and printing
the raw `(t, y_from_bottom)` series explained why -- the ball wasn't visible at all for the first
~0.57s of the 1.8s pre-roll window, and once it appeared it was already near its peak height and
barely moving for several frames, before descending and settling into a narrow band (net entry).
That's the *back half* of an arc (peak, descent, net-settle), not a full release-to-landing flight
-- the true release happened before the window even started.

**Fixed**: widened `PRE_ROLL` from 1.8s to 3.0s and shrunk `POST_ROLL` from 0.6s to 0.4s in
`extract_frames.py` (the old window's last ~0.3s showed no new flight info, just net-settle).
Re-extracted all 10 sample shots and visually confirmed on `02_Evan_make`: the ball is now visible
in the very first frame, already in the shooter's hand mid-windup, well before release. Regenerated
`labeling-manifest.js` too.

**One real cost**: `02_Evan_make`'s existing labels no longer line up with the re-extracted frames
(different window, different frame numbering) and need to be redone. Saved at
`shot-arc/labels/02_Evan_make-labels.json` for reference, but it's now stale -- worth re-labeling
that one shot under the new window before doing the other 9, so all of them land in one consistent
window from the start.

## Real bug: some "shots" are actually two connected plays, not one clean flight

Ben caught this directly: `00_Adam_make` was "named Adam make but it is an Adam miss and it only
starts after the ball hits the rim and then the ensuing rebound." Checked the real game log --
he was exactly right. Two separate scoring events, 6.8s apart:

```
t=228.26  Adam  made=False  rebounderId=Ian
t=235.07  Adam  made=True   assistId=Ian
```

Adam missed, Ian rebounded, passed it right back, Adam put it back in. `00_Adam_make` is that
*second* event (a real, correctly-recorded make) -- but no fixed-size window anchored on it can
ever show a single clean parabola, because the actual story is two possessions stitched together,
not one shot. My own earlier window-widening (see above) had been *tuned against exactly this
kind of sample* without knowing it -- 02_Evan_make, the shot that drove that tuning, turned out to
have the identical signature (a miss 3.4s earlier, different shooter, same rebound-putback
pattern). That data was never representative of a clean shot to begin with.

Checked all 10 original samples for the same signature (any other scoring event in the same game
within 8s before it): **3 of 10 (00, 02, 05) had it.** Common enough that this needs to be a
selection-time filter, not something caught one at a time by hand-labeling.

**Fixed**: `select_sample_shots.py` now excludes any candidate preceded within
`CLEAN_SHOT_GAP_SECONDS = 8` by another scoring event in the same game (104 of 362 originally
eligible shots got excluded by this -- almost 30%, a real rate, not an edge case). Re-ran
selection + extraction with the new filter; all 10 current samples are isolated possessions.
Also walked `POST_ROLL` back up from 0.4s to 1.0s, since that number had been derived from a
scramble play's own net-settle tail, not a clean shot's actual landing time, and wasn't
trustworthy either.

The two stale label files (`00_Adam_make`, `02_Evan_make`) are kept at `shot-arc/labels/rejected/`
for reference -- both are real, checkable examples of the scramble-play signature this filter now
catches -- but shouldn't be used for training.

## Real bug #2: a dunk isn't a free-flying shot, and there was no way to flag it

The very next fully-labeled shot (`00_Evan_make`) had a much higher residual than the first
(51.5px vs. 18.6) and a trajectory that swung x back and forth (423 -> 541 -> 247 -> 530) instead
of tracing one arc. Ben identified it directly: "it is a dunk." That's a different failure mode
from the rebound/putback case above -- the ball is carried by hand through most of a dunk, not in
free flight, so no amount of trimming (or a bigger `CLEAN_SHOT_GAP_SECONDS`) would ever make one
fit a parabola. Unlike the rebound case, there was no existing field to filter on: Poolean's
`scoringEvent` schema had no `dunk` flag at all (Adam's own PoolVision `judged.json` does).

**Fixed, at the source**: added a `dunk` boolean to the Stat Entry shot-confirmation flow (a
toggle next to "Where was it from?", defaults off, resets between shots) so every *new* shot
carries this going forward. For the backlog of shots logged before the field existed, added a
"Review Possible Dunks" panel (Export tab) listing every close/midrange 2PT field goal with
`dunk === undefined` (not yet reviewed), each with a Watch Film link and Dunk / Not a dunk
buttons -- either answer resolves it and drops it off the list. `select_sample_shots.py` should
eventually also skip `ev.dunk === true` once enough of the backlog is reviewed to make that
filter meaningful; not done yet since the backlog is still largely unreviewed.

The two dunk label files (`00_Evan_make`, and the earlier `00_Adam_make`/`02_Evan_make` rebound
cases) all live under `shot-arc/labels/rejected/` now -- real, checkable examples of why arc
fitting needs clean single-flight data, not just any make.

## Labeling tool: sparse click + interpolate, and a multi-touch trim

Two follow-on tool improvements, both from real usage:

- **Speed**: clicking every single frame (up to 120 per shot now) was the real time cost. Added a
  "Step" size (default 3) -- clicking a frame now jumps ahead by that many, and on download,
  straight-line interpolation fills the skipped frames between any two real clicks (capped at an
  8-frame gap, beyond which a straight line isn't trustworthy -- left as `unlabeled`/`no-ball`
  instead). Verified directly: a click at frame 1 (0,0) and frame 5 (40,40) correctly filled
  frames 2-4 at (10,10)/(20,20)/(30,30).
- **Multi-touch trim**: `00_Evan_make`'s zigzag trajectory (before "it is a dunk" explained it
  outright) also exposed a separate real gap -- a labeled window can contain more than the shot
  itself (a pass, a dribble, before the actual release). Added "Mark Shot Start"/"Mark Shot End"
  buttons; only that frame range is used on export (interpolation never crosses outside it, and
  frames outside get `status: "outside-shot"`), defaulting to the whole clip when unset.

Also added "Not a valid shot (dunk, etc.)" -- downloads a small `{shotKey, excluded, reason}`
marker instead of a full label file, for a clip recognized as unusable before spending time on it.

## Files (prototype only, not wired into the app)

All local to `shot-arc/`. `frames/`, `*.pt` (model weights), `*.png` (including the debug crops
referenced above), and the JSON outputs are gitignored (large, fully regenerable locally by
re-running the three scripts in order) — only this findings doc and the three pipeline scripts
themselves are tracked in git.

## Adam delivered his real ball-training dataset — and a much bigger finding underneath it

Adam sent `poolvision-balldata-{1,2}of2.zip` (share.adammirmina.com/poolvision-balldata-80bc71c110).
Unzipped into `shot-arc/adam-balldata/balldata/` (gitignored, 392 real images + YOLO labels —
verified the counts match his README exactly: 323 train + 69 val). Spot-checked one image
directly: a real, clearly-visible ball mid-flight, genuine data, not a placeholder.

**Corrections to what I'd assumed:**

- 323 is the train split only. 392 total (323 train + 69 val), not 323.
- **None of the boxes are hand-drawn.** Same self-bootstrapping technique guessed at from reading
  `balldata.py` earlier: for a shot with a good parabola fit through the sightings stock detection
  *did* make (RMS <= 14px, >= 8 points), the fit predicts the ball's position in the frames stock
  detection missed — and those missed frames were sampled first, on purpose, specifically because
  they're the hard cases (blur, skin, inside the net, behind the rim). Labels are "as good as the
  arc fit, not as good as a human," per his own README.
- **The 960px crop isn't a fixed frame — it *tracks the ball*.** Each crop is centered on that
  shot's own predicted ball position, clamped to the source frame. This is the actual answer to
  the crop question this doc raised earlier: the earlier quick test here (a single hand-picked
  static crop box on one shot, 0/72 hits) wasn't a fair test of "does cropping help" — it was
  testing a *static* crop, and the real technique is dynamic. His own validation: rolling the
  crop up to 240px off the true center still scored 60/60 on held-out hard frames, so there's real
  tolerance, but "a static box the play walks out of is a different thing" — his own words,
  matching exactly what this doc's earlier test actually showed.
- **Fine-tuned weights exist** (`ball-best.pt`, yolo11s from COCO, trained on this same dataset)
  on the same share link, not yet downloaded here — worth grabbing to fine-tune from those instead
  of raw COCO, if fine-tuning happens at all (see below).

## The resolution finding matters more than any of the above

Adam's own words: "the part that mattered most for us was native pixels on the ball. Downscaling
a 4K frame to 1280 missed every shot in one run... If your footage is 1280x720 as recorded, the
ball is already close to the size that broke ours, so the fine-tune will help less there than a
camera setting would."

Checked our own footage directly: `ffprobe` on `game-videos/g7ko31w6njargwe.mp4` confirms **1280x720**
— exactly the resolution class Adam says broke his own detector.

**But this doesn't settle it yet, and is a real open question, not a conclusion:** every local shot
prototyped against so far (`game-videos/*.mp4`) is a *deliberately re-encoded copy*, per
`dashboard-viewer/viewer-videos.js`'s own comment — "extracted straight from the real session
recording and re-encoded down (720p, libx264 CRF 26) to stay well under GitHub's 100MB per-file
limit." That comment explicitly distinguishes these from "the raw, multi-game session file." The
*original* session recordings (referenced by `masterVideoId`) live only in Ben's own browser
IndexedDB, not as plain files this environment can reach, and their actual native resolution is
genuinely unknown here.

**Real next step, not yet done:** find out what resolution the original session recordings
actually are (what device/app recorded them, at what setting) before concluding anything about
whether fine-tuning would help. If the source was already 1280x720 at capture, Adam's warning
applies directly and a camera setting change for *future* games is the higher-leverage fix. If the
source was recorded at a higher resolution and only downscaled for GitHub hosting later, there's a
real, recoverable opportunity: re-export the master videos at native resolution for this pipeline
specifically (a separate, non-hosted export, since 4K files have no reason to go through the same
100MB-per-file GitHub Pages constraint the public viewer's clips do).

Update: it's Adam's phone recording (his camera app, "probably 1080p or 4K" per Ben) -- almost
certainly not natively 1280x720, so the `game-videos/*.mp4` files really are just a downscaled
hosting copy, not a ceiling on what's actually recoverable. Still hasn't been directly confirmed
(no raw master file inspected yet), but the resolution test below no longer needs that answer to
be useful on its own.

## Downloaded and tested Adam's fine-tuned weights -- real result, with a real complication caught along the way

Downloaded `poolvision-ball-best.pt` (18.3MB, share link from his email) and validated it properly
before trusting it, since a checkpoint that merely *loads* isn't the same as one that *works*.

**First pass looked broken, and almost got reported that way.** Running it at the same settings
train_args records (imgsz 640) against Adam's own held-out val set: 0 real detections out of 20
images even at a very low 0.01 confidence threshold, and `model.val()` (once its own `path: .`
resolution issue in `data.yaml` was worked around by running from inside the unzipped folder, as
his README warned it might need) gave a real but unimpressive mAP50 of 0.275 -- nowhere near
"60/60." Ground-truth label positions, checked directly against the same images, are correctly
placed right on the ball every time, ruling out a labeling problem on his end or a loading problem
on mine.

**The actual explanation: a threshold-vs-ranking mismatch, not a broken model.** Checked whether
the model's own *top-ranked* detection (by confidence, regardless of the absolute confidence
number, which never got very high) lands near the true position -- it does: 62/69 within 50px,
68/69 within 100px on his val set, matching his "60/60" claim once evaluated the way he almost
certainly meant it (best candidate per frame, not "how many detections clear an arbitrary absolute
threshold"). The model's confidence *calibration* is off; its *localization* is not. Worth telling
Adam about the calibration finding -- it's a real, useful thing to know about his own checkpoint,
independent of anything about our footage.

**Then tested directly against real hand-labeled frames from our own footage** (the dunk shot
labeled earlier, `labels/rejected/00_Evan_make-labels.json` -- its own frames had been overwritten
by the later clean-sample re-extraction, so re-extracted just that one shot's 120 frames again from
the same game/timestamp to match the label file exactly):

- **Full 1280x720 frame, no crop:** 0/120 within 20px, 3/120 within 100px. Essentially the same
  wall this doc already hit with stock detection.
- **960px crop centered exactly on the true ball position** (an "oracle" crop -- cheats by using
  the real label to place it, isolating "does cropping help" from "can we find the ball to crop
  around" as two separate questions): **54/120 (45%) within 20px, 73/120 (61%) within 100px.**

That's the real answer to the open question above, and it didn't need to wait on the master-file
resolution question at all: **the crop matters far more than this doc's earlier test suggested,
and matters more than a moderate resolution gap.** Adam's own warning still shows up as a real,
honest cost -- 45-61% on our footage against his own 90-98.6% on native 4K is a genuine gap, not
nothing -- but it's a longer, still-usable tail, not the near-total wipeout full-frame detection
produced. Combined with the same parabola-fit bootstrapping his own dataset was built with (only
some real detections per shot are needed to fit an arc and predict the rest), this looks like a
real, viable path, not a dead end.

**Real next step, not yet done:** the oracle crop cheats by already knowing where the ball is,
which a fresh, unlabeled shot never does going in. The actual bootstrapping problem is: run
detection on the full frame first (accepting a very low hit rate) to find a small number of seed
frames, then propagate a moving crop from each seed forward/backward a few frames at a time (ball
position can't jump far frame-to-frame at 30fps), refitting the crop as new detections come in --
the same temporal-tracking idea Adam's own crop-follows-the-ball description implies, just not
implemented here yet.
