"""Re-fits every existing *-tracked.json with the current fit logic (hand-labeled range if present,
otherwise an auto-detected flight that ends at a hoop) without re-running extraction or tracking.
Hoop positions are cached per shot in <key>-hoops.json since detecting them decodes many 4K frames.
Writes pipeline_results_refit.json."""
import json
from pathlib import Path

from hoops import detect_hoops, rim_centers
from run_pipeline import fit_shot, safe_shot_key
from select_sample_shots import DUNK_SOURCE, find_clean_candidates

AMBIGUOUS_GAP_S = 1.0  # another logged shot this close to the flight means it might be that shot's flight
FPS = 30
WINDOW_PRE_S = 1.0     # the extraction window starts this long before the logged time

FRAME_H = 2160  # 4K source
here = Path(__file__).parent
cands = {safe_shot_key(c): c for c in find_clean_candidates()}
dunks = {k: c["dunk"] for k, c in cands.items()}
_state = json.loads(DUNK_SOURCE.read_text(encoding="utf-8"))
event_times = {
    g["id"]: sorted(e["videoTime"] for e in g["scoringEvents"] if e.get("videoTime") is not None and e.get("points") in (1, 2, 3))
    for g in _state["games"]
}
out = []
for f in sorted(here.glob("real_*-tracked.json")):
    key = f.name[: -len("-tracked.json")]
    tracked = json.loads(f.read_text(encoding="utf-8"))
    cache = here / f"{key}-hoops.json"
    blobs = json.loads(cache.read_text()) if cache.exists() else []
    if not (blobs and isinstance(blobs[0], dict)) and (here / "frames" / key).exists():
        blobs = detect_hoops(key)
        cache.write_text(json.dumps(blobs))
    hoops = rim_centers(blobs) if blobs and isinstance(blobs[0], dict) else []
    fit = fit_shot(tracked, FRAME_H, key, hoops, dunks.get(key, False))
    if fit.get("usable") and key in cands:
        c = cands[key]
        lo, hi = fit["frame_range"]
        flight_start = c["video_time_abs"] - WINDOW_PRE_S + (lo - 1) / FPS
        flight_end = c["video_time_abs"] - WINDOW_PRE_S + hi / FPS
        gaps = [
            min(abs(o - flight_start), abs(o - flight_end))
            for o in event_times.get(c["game_id"], [])
            if abs(o - c["video_time_abs"]) > 0.01 and flight_start - 1 <= o <= flight_end + 1
        ]
        near = min(gaps) if gaps else None
        fit["attribution"] = f"ambiguous: another logged shot {near:.1f}s from the flight" if near is not None and near < AMBIGUOUS_GAP_S else "clear"
    out.append({"shot_key": key, "n_frames": len(tracked["frames"]), "fit": fit})
(here / "pipeline_results_refit.json").write_text(json.dumps(out, indent=2, default=float))
usable = [r for r in out if r["fit"].get("usable")]
print(f"{len(usable)}/{len(out)} usable")
