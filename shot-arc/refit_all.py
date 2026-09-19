"""Re-fits every existing *-tracked.json with the current fit logic (hand-labeled range if present,
otherwise an auto-detected flight that ends at a hoop) without re-running extraction or tracking.
Hoop positions are cached per shot in <key>-hoops.json since detecting them decodes many 4K frames.
Writes pipeline_results_refit.json."""
import json
from pathlib import Path

from hoops import detect_hoops, rim_centers
from run_pipeline import fit_shot, safe_shot_key
from select_sample_shots import find_clean_candidates

FRAME_H = 2160  # 4K source
here = Path(__file__).parent
dunks = {safe_shot_key(c): c["dunk"] for c in find_clean_candidates()}
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
    out.append({"shot_key": key, "n_frames": len(tracked["frames"]), "fit": fit_shot(tracked, FRAME_H, key, hoops, dunks.get(key, False))})
(here / "pipeline_results_refit.json").write_text(json.dumps(out, indent=2, default=float))
usable = [r for r in out if r["fit"].get("usable")]
print(f"{len(usable)}/{len(out)} usable")
