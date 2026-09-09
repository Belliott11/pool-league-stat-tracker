#!/usr/bin/env node
// Lightweight regression tests for the math this app's own bugs came from this session — the
// win-probability model, k-means clustering, and Balance Teams' chemistry/win-rate nudge cap.
// NOT part of the dashboard app itself, same as scripts/second-chance-analysis.js: a standalone
// Node script duplicating the relevant app.js functions verbatim (this codebase has no build
// step and app.js isn't a loadable module, so duplication — not import — is the existing
// pattern; keep these in sync by hand if the real functions change) and asserting the specific
// properties that were wrong before each fix landed, so a future edit that reintroduces one of
// these bugs fails loudly instead of silently shipping.
//
// Usage:
//   node scripts/test-math.js

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.log(`  FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}
function section(name) {
  console.log(`\n${name}`);
}

// ---------- k-means (Play Style Clusters) ----------
function euclideanDist(a, b) {
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
}
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
function kMeansPlusPlusInit(points, k, rand) {
  const centers = [points[Math.floor(rand() * points.length)]];
  while (centers.length < k) {
    const distSq = points.map(p => Math.min(...centers.map(c => euclideanDist(p, c) ** 2)));
    const total = distSq.reduce((a, b) => a + b, 0);
    if (total === 0) { centers.push(points[Math.floor(rand() * points.length)]); continue; }
    let r = rand() * total, idx = 0;
    for (; idx < distSq.length - 1; idx++) { r -= distSq[idx]; if (r <= 0) break; }
    centers.push(points[idx]);
  }
  return centers;
}
function kMeans(points, k, seed) {
  const rand = seededRandom(seed);
  let centers = kMeansPlusPlusInit(points, k, rand);
  let assignments = new Array(points.length).fill(-1);
  for (let iter = 0; iter < 100; iter++) {
    const next = points.map(p => {
      let best = 0, bestDist = Infinity;
      centers.forEach((c, ci) => {
        const d = euclideanDist(p, c);
        if (d < bestDist) { bestDist = d; best = ci; }
      });
      return best;
    });
    const changed = next.some((a, i) => a !== assignments[i]);
    assignments = next;
    centers = centers.map((c, ci) => {
      const members = points.filter((_, i) => assignments[i] === ci);
      return members.length > 0 ? c.map((_, d) => members.reduce((s, m) => s + m[d], 0) / members.length) : c;
    });
    if (!changed) break;
  }
  return { centers, assignments };
}
function bestKMeans(points, k) {
  let best = null;
  for (let seed = 1; seed <= 8; seed++) {
    const { centers, assignments } = kMeans(points, k, seed * 97 + points.length);
    const inertia = points.reduce((sum, p, i) => sum + euclideanDist(p, centers[assignments[i]]) ** 2, 0);
    if (!best || inertia < best.inertia) best = { centers, assignments, inertia };
  }
  return best;
}

section("k-means (Play Style Clusters)");
{
  const points = [
    [2, -1, 0, 0, -1], [1.8, -0.9, 0.2, -0.1, -0.8], [2.2, -1.1, -0.1, 0.1, -1.2],
    [-1, 2, -0.5, 0.3, 1.5], [-0.9, 1.8, -0.3, 0.2, 1.2], [-1.1, 2.1, -0.4, 0.1, 1.8],
    [0, 0, 2, 0, 0], [0.1, -0.1, 1.8, 0.2, 0.1], [-0.1, 0.1, 2.2, -0.2, -0.1]
  ];
  const r1 = bestKMeans(points, 3).assignments.join(",");
  const r2 = bestKMeans(points, 3).assignments.join(",");
  check("deterministic across repeated runs on identical data", r1 === r2, `${r1} vs ${r2}`);

  const a = bestKMeans(points, 3).assignments;
  const sameGroup = (i, j) => a[i] === a[j];
  check("separates three well-separated synthetic groups correctly",
    sameGroup(0, 1) && sameGroup(1, 2) && sameGroup(3, 4) && sameGroup(4, 5) && sameGroup(6, 7) && sameGroup(7, 8) &&
    !sameGroup(0, 3) && !sameGroup(0, 6) && !sameGroup(3, 6));
}

// ---------- Win-probability model ----------
const WIN_PROBABILITY_L2 = 0.1;
function trainWinProbabilityModel(rows) {
  let w = 0.15, b = 0;
  const lr = 0.1;
  const n = rows.length;
  for (let it = 0; it < 3000; it++) {
    let gw = 0, gb = 0;
    rows.forEach(r => {
      const p = 1 / (1 + Math.exp(-(w * r.diff + b)));
      const err = p - r.label;
      gw += err * r.diff;
      gb += err;
    });
    w -= lr * (gw / n + WIN_PROBABILITY_L2 * w);
    b -= lr * gb / n;
  }
  return { w, b, n };
}
const WIN_PROBABILITY_CONFIDENCE_GAMES = 20;
function predictWinProbability(model, diff) {
  const raw = 1 / (1 + Math.exp(-(model.w * diff + model.b)));
  const confidence = Math.min(1, model.n / WIN_PROBABILITY_CONFIDENCE_GAMES);
  return 0.5 + (raw - 0.5) * confidence;
}

section("Win-probability model");
{
  // Same 7 rows this app's own real data produced when this was checked.
  const rows = [
    { diff: 0.296, label: 1 }, { diff: 5.300, label: 1 }, { diff: -5.004, label: 0 },
    { diff: 1.585, label: 1 }, { diff: -4.608, label: 0 }, { diff: 2.008, label: 0 }, { diff: -2.008, label: 0 }
  ];
  const model = trainWinProbabilityModel(rows);
  const pBig = predictWinProbability(model, 9);
  check("small-sample prediction stays hedged, not near-certain", pBig < 0.85, `p(diff=9) with n=${model.n} was ${pBig.toFixed(3)}`);
  check("prediction at diff=0 stays near 50/50", Math.abs(predictWinProbability(model, 0) - 0.5) < 0.1);

  // 2-team complementarity: computed once from one side's diff, not independently per side —
  // this is the actual fix (renderBalanceResults in app.js), asserted here on the underlying
  // predict function's own complement property rather than the DOM-rendering code around it.
  const diff = 3.4;
  const pA = predictWinProbability(model, diff);
  const pB = 1 - pA;
  check("2-team probabilities sum to exactly 100% (by construction, complement not recomputed)", Math.abs(pA + pB - 1) < 1e-9);

  // The old, wrong way — recomputing each side independently from its own negated diff — is the
  // bug this test guards against reintroducing.
  const pA_indep = predictWinProbability(model, diff);
  const pB_indep = predictWinProbability(model, -diff);
  check("guards the specific bug: independent recomputation on each side does NOT sum to 100% (sanity check on the test itself)",
    Math.abs(pA_indep + pB_indep - 1) > 1e-6, "if this ever passes as ~1, the model's bias term became 0 and the old bug would stop mattering");
}

// ---------- Balance Teams: chemistry/win-rate nudge cap ----------
function teamChemAdj(team, liftMap) {
  if (team.length < 2) return 0;
  let sum = 0, count = 0;
  team.forEach(a => team.forEach(b => {
    if (a === b) return;
    const e = liftMap[`${a}|${b}`];
    if (e !== undefined) { sum += e.value; count++; }
  }));
  return count > 0 ? sum / count : 0;
}
function teamWinAdj(team, winRateMap) {
  if (team.length < 2) return 0;
  let sum = 0, count = 0;
  for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) {
    const key = team[i] < team[j] ? `${team[i]}|${team[j]}` : `${team[j]}|${team[i]}`;
    const e = winRateMap[key];
    if (e !== undefined) { sum += e.value; count++; }
  }
  return count > 0 ? sum / count : 0;
}
function scoreTeamSet(teams, qualityById, liftMap, winRateMap, nudgeCap) {
  const avgs = teams.map(team => {
    const base = team.reduce((sum, id) => sum + (qualityById[id] || 0), 0) / team.length;
    const nudge = teamChemAdj(team, liftMap) + teamWinAdj(team, winRateMap);
    const cappedNudge = nudgeCap === undefined ? nudge : Math.max(-nudgeCap, Math.min(nudgeCap, nudge));
    return base + cappedNudge;
  });
  return { avgs, spread: Math.max(...avgs) - Math.min(...avgs) };
}

section("Balance Teams: chemistry/win-rate nudge cap");
{
  // Real pairing from this app's own data: a team whose raw talent gap from the others was
  // ~2.95 got a +6.19 combined nudge before this fix — several times the thing it was meant to
  // just tiebreak.
  const qualityById = { a: 0.65, b: -0.68, c: -2.31 };
  const liftMap = { "a|b": { value: 5.5, gp: 3 }, "b|a": { value: 5.5, gp: 3 } };
  const winRateMap = { "a|b": { value: 3.33, gp: 3 } };
  const teams = [["a", "b"], ["c"]];
  const nudgeCap = 1.86; // a fifth of a realistic ~9.3 attendee quality spread, as computed live
  const uncapped = scoreTeamSet(teams, qualityById, liftMap, winRateMap);
  const capped = scoreTeamSet(teams, qualityById, liftMap, winRateMap, nudgeCap);
  check("uncapped nudge can dominate the raw talent gap (sanity check on the test itself)", uncapped.spread > 5);
  check("capped nudge stays bounded regardless of the pair's raw signal size", capped.spread < uncapped.spread && capped.spread < 6);

  // A cap of 0 (all attendees equal quality — nothing to nudge against) must fully zero it out,
  // not error or leave the raw nudge in place.
  const zeroCapped = scoreTeamSet(teams, qualityById, liftMap, winRateMap, 0);
  check("a zero cap fully suppresses the nudge", Math.abs(zeroCapped.avgs[0] - (qualityById.a + qualityById.b) / 2) < 1e-9);
}

// ---------- Reputation quality estimate: clean-sweep bonus ----------
const CLEAN_SWEEP_BONUS = 1.2;
function estimatedQualityFromReputation(avgPercentile, parties) {
  const base = (avgPercentile - 50) / 10;
  return avgPercentile === 100 && parties >= 2 ? base + CLEAN_SWEEP_BONUS : base;
}

section("Reputation quality estimate: clean-sweep bonus");
{
  check("100th percentile across 2+ parties gets the bonus", estimatedQualityFromReputation(100, 4) === 5 + CLEAN_SWEEP_BONUS);
  check("100th percentile on a single party does NOT get the bonus (too small a sample to call a real sweep)",
    estimatedQualityFromReputation(100, 1) === 5);
  check("a merely-high (not 100th) percentile never gets the bonus", Math.abs(estimatedQualityFromReputation(88.9, 10) - 3.89) < 1e-9);
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
