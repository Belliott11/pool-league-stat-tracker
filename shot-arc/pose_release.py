"""
Release-point tracking prototype (Part 3 of the video-backed dev spec), using stock
yolo11s-pose.pt -- the same model PoolVision itself uses un-fine-tuned (see POOLVISION-NOTES.md),
so unlike ball detection this needs no local training data at all.

For each sample shot, run pose detection across the frame window and track each detected person
across frames (simple greedy nearest-box matching -- with only ~72 frames at 30fps and everyone
detected every frame, re-identification through occlusion never comes up here), then compute
wrist height relative to shoulder width for whichever track looks the most shot-like: it just
finished a single, cleanest rise-then-fall in wrist height, not a track that's high in one frame
and low the next for no reason.

FIXED: the first version of this took the max wrist-height reading across every detected person
IN EACH FRAME independently, which silently jumps between different people frame to frame --
caught by spot-checking one shot's series (3.39 -> 8.22 -> 2.2 -> 9.6, obviously not one person's
arm) rather than trusting numbers that looked plausible at a glance. This version tracks one
person at a time across the whole window before measuring anything, which removes that specific
noise source. It does NOT solve shooter identification the way PoolVision's own cap-color/
ball-origin logic does -- "the track with the cleanest rise-then-fall" is a real heuristic, not
a proven answer, and is reported as such below.

Keypoint indices are the standard Ultralytics/COCO-17 order: 0 nose, 5/6 shoulders, 9/10 wrists.
"""
import json
from pathlib import Path

from ultralytics import YOLO

FRAMES_ROOT = Path(__file__).parent / "frames"
FPS = 30
POSE_CONF = 0.15
NOSE, LSH, RSH, LWR, RWR = 0, 5, 6, 9, 10
MATCH_DIST_PX = 220   # max center-to-center move allowed between consecutive frames to
                       # count as the same person; a fast swimmer covers well under this
                       # in 1/30s, an actual identity swap would need to jump much further
MAX_MISSED_FRAMES = 4  # frames a track can go undetected before it's considered ended
MIN_TRACK_LEN = 15     # ignore tracks too short to say anything about a rise-and-fall


def box_center(box):
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2, (y1 + y2) / 2)


def track_people(preds):
    """Greedy nearest-center tracking across frames. Returns a list of tracks, each a list of
    {frame, t, box, kp} dicts in frame order."""
    active = []   # [{id, last_frame, last_center, points: [...]}]
    finished = []
    next_id = 0

    for fi, r in enumerate(preds):
        t = fi / FPS
        dets = []
        if r.keypoints is not None and len(r.keypoints.data) > 0:
            boxes = r.boxes.xyxy.tolist()
            kps = r.keypoints.data.tolist()
            for box, kp in zip(boxes, kps):
                dets.append({"box": box, "kp": kp, "center": box_center(box)})

        used = set()
        for tr in active:
            best_j, best_d = None, MATCH_DIST_PX
            for j, d in enumerate(dets):
                if j in used:
                    continue
                cx, cy = tr["last_center"]
                dx, dy = d["center"][0] - cx, d["center"][1] - cy
                dist = (dx * dx + dy * dy) ** 0.5
                if dist < best_d:
                    best_j, best_d = j, dist
            if best_j is not None:
                used.add(best_j)
                tr["points"].append({"frame": fi, "t": t, "box": dets[best_j]["box"], "kp": dets[best_j]["kp"]})
                tr["last_center"] = dets[best_j]["center"]
                tr["last_frame"] = fi
            # else: no match this frame -- leave the track as-is, checked for expiry below

        still_active = []
        for tr in active:
            if fi - tr["last_frame"] > MAX_MISSED_FRAMES:
                finished.append(tr)
            else:
                still_active.append(tr)
        active = still_active

        for j, d in enumerate(dets):
            if j not in used:
                active.append({"id": next_id, "last_frame": fi, "last_center": d["center"],
                                "points": [{"frame": fi, "t": t, "box": d["box"], "kp": d["kp"]}]})
                next_id += 1

    finished.extend(active)
    return [tr["points"] for tr in finished if len(tr["points"]) >= MIN_TRACK_LEN]


def wrist_height_metric(kp):
    """Highest wrist above the shoulder line, in shoulder-widths (positive = above)."""
    lsh, rsh = kp[LSH], kp[RSH]
    if lsh[2] < 0.3 or rsh[2] < 0.3:
        return None
    shoulder_y = (lsh[1] + rsh[1]) / 2
    shoulder_width = abs(lsh[0] - rsh[0])
    if shoulder_width < 3:
        return None
    best = None
    for w in (kp[LWR], kp[RWR]):
        if w[2] < 0.3:
            continue
        above = (shoulder_y - w[1]) / shoulder_width
        if best is None or above > best:
            best = above
    return best


def track_series(track):
    out = []
    for p in track:
        m = wrist_height_metric(p["kp"])
        if m is not None:
            out.append((round(p["t"], 3), round(m, 2)))
    return out


def shot_likeness(series):
    """How much this track looks like ONE clean rise-then-fall, not noise.

    Scored as (peak height) minus (how jagged the series is around it) -- a track that's high in
    one frame and low the next scores worse than one that ramps up and back down smoothly, even
    at the same peak, since a real arm motion can't teleport between frames 1/30s apart.
    """
    if len(series) < MIN_TRACK_LEN:
        return None
    vals = [v for _, v in series]
    peak = max(vals)
    jaggedness = sum(abs(vals[i + 1] - vals[i]) for i in range(len(vals) - 1)) / len(vals)
    return peak - jaggedness


def main():
    shots = json.loads((Path(__file__).parent / "sample_shots.json").read_text())
    model = YOLO("yolo11s-pose.pt")
    results = []
    for i, s in enumerate(shots):
        key = f"{i:02d}_{s['shooter']}_{'make' if s['made'] else 'miss'}"
        frames = sorted((FRAMES_ROOT / key).glob("frame_*.png"))
        if not frames:
            continue
        preds = model.predict([str(f) for f in frames], verbose=False, conf=POSE_CONF, imgsz=1280)
        frames_with_people = sum(1 for r in preds if r.keypoints is not None and len(r.keypoints.data) > 0)

        tracks = track_people(preds)
        scored = []
        for tr in tracks:
            series = track_series(tr)
            score = shot_likeness(series)
            if score is not None:
                scored.append((score, tr, series))
        scored.sort(key=lambda x: x[0], reverse=True)

        best = scored[0] if scored else None
        row = {
            "key": key, "shooter": s["shooter"], "made": s["made"],
            "frames_total": len(frames),
            "frames_with_a_person": frames_with_people,
            "tracks_found": len(tracks),
            "shooter_track": None,
        }
        if best:
            score, tr, series = best
            peak = max(series, key=lambda p: p[1])
            row["shooter_track"] = {
                "score": round(score, 2), "track_length": len(tr),
                "series": series, "peak_wrist_height": peak,
            }
            print(f"{key}: {len(tracks)} people tracked ({frames_with_people}/{len(frames)} frames had someone) "
                  f"-- best track: {len(tr)} frames, peak {peak[1]} shoulder-widths at t={peak[0]}s, "
                  f"shot-likeness score {round(score,2)}")
        else:
            print(f"{key}: {len(tracks)} people tracked, none long/clean enough to call a shot motion")
        results.append(row)

    out_path = Path(__file__).parent / "pose_results.json"
    out_path.write_text(json.dumps(results, indent=2))

    with_shot = [r for r in results if r["shooter_track"]]
    print(f"\n{len(with_shot)}/{len(results)} shots produced a trackable, coherent shot-motion candidate.")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
