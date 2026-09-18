"""Re-fits every existing *-tracked.json with the current fit logic (hand-labeled range if present,
otherwise the auto-detected flight segment) without re-running extraction or tracking. Writes
pipeline_results_refit.json next to pipeline_results.json's shape, joined by shot key."""
import json
from pathlib import Path
from run_pipeline import fit_shot

FRAME_H = 2160  # 4K source
here = Path(__file__).parent
out = []
for f in sorted(here.glob("real_*-tracked.json")):
    key = f.name[: -len("-tracked.json")]
    tracked = json.loads(f.read_text(encoding="utf-8"))
    out.append({"shot_key": key, "n_frames": len(tracked["frames"]), "fit": fit_shot(tracked, FRAME_H, key)})
(here / "pipeline_results_refit.json").write_text(json.dumps(out, indent=2, default=float))
usable = [r for r in out if r["fit"].get("usable")]
print(f"{len(usable)}/{len(out)} usable")
