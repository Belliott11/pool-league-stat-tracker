"""Compare the PC's fine-tuned-detector run (ft_full/) with the laptop's arcs (shot_arcs.csv)."""
import csv, json
from collections import Counter
from pathlib import Path

here = Path(__file__).parent
ft = here / "ft_full"

def key_of(game, t):
    whole, frac = f"{t:.3f}".split(".")
    return f"{game}_{whole}_{frac}"

def load(name):
    return {key_of(r["game_id"], r["video_time_abs"]): r for r in json.loads((ft / name).read_text(encoding="utf-8"))}

main = load("pipeline_results_ft.json")
retry = load("pipeline_results_ft_retry.json")
merged = dict(main)
for k, r in retry.items():
    merged[k] = r   # the retry re-ran these shots; its result supersedes the 0.3 one
def usable(r): return bool(r["fit"].get("usable"))

laptop = {f'{r["game_id"]}_{r["video_time"].replace(".", "_")}': r for r in csv.DictReader(open(here / "shot_arcs.csv"))}
all_laptop = {r["shot_key"][len("real_"):] : r for r in json.loads((here / "pipeline_results_refit.json").read_text(encoding="utf-8"))}

print(f"PC main run: {sum(map(usable, main.values()))}/{len(main)} usable; retry: {sum(map(usable, retry.values()))}/{len(retry)}; merged: {sum(map(usable, merged.values()))}/{len(merged)}")
print(f"laptop verified arcs: {len(laptop)}; laptop refit usable: {sum(1 for r in all_laptop.values() if r['fit'].get('usable'))}/{len(all_laptop)}")
ft_use = {k for k, r in merged.items() if usable(r)}
lap_use = set(laptop)
print(f"laptop keys found in PC shot list: {len(lap_use & set(merged))}/{len(lap_use)}")
print(f"both usable: {len(ft_use & lap_use)}; PC only: {len(ft_use - lap_use)}; laptop only: {len(lap_use - ft_use)}")
print("laptop-only, PC result:", Counter((merged[k]['fit'].get('reason') or 'usable')[:60] for k in lap_use - ft_use if k in merged))
# how did the ones both found compare (flight window agreement)
diffs = []
for k in ft_use & lap_use:
    a = merged[k]["fit"]; b = laptop[k]
    diffs.append(abs(a["flight_duration_s"] - float(b["flight_s"])))
if diffs:
    diffs.sort(); print(f"flight duration difference on shared arcs: median {diffs[len(diffs)//2]:.2f}s, max {diffs[-1]:.2f}s")
print("\nPC-only usable by game:", Counter(k.split("_")[0] for k in ft_use - lap_use))
print("PC unusable reasons:", Counter((r['fit'].get('reason') or '')[:50] for r in merged.values() if not usable(r)).most_common(8))
json.dump(sorted(ft_use - lap_use), open(here / "ft_full" / "pc_only_keys.json", "w"))
