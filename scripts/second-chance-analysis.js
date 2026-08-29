#!/usr/bin/env node
// One-off, read-only analysis script — NOT part of the dashboard app. Doesn't touch the
// logging interface, the scoringEvents schema, or how data gets entered; it only reads a
// "Download JSON" export (Export -> Export All Data) and computes "true" second-chance
// conversion from data that's already there: rebounderId, assistId, and videoTime.
//
// Definition: a missed shot with a rebounderId on the shooter's own team is an offensive
// rebound. That rebound counts as *converted* if, within N seconds of the missed shot's own
// videoTime, either the rebounder themselves scored, or someone else scored with assistId
// equal to the rebounder. Either path counts — this isn't "did the rebounder score," it's
// "did that offensive rebound lead to points," which credits a kick-out assist the same as
// a putback.
//
// Both the missed shot and the candidate scoring event need a real videoTime to be evaluated
// against the window — a shot logged without one can't be placed in time relative to anything,
// so it's excluded from the conversion check (though it's still counted toward OREB total,
// since that part doesn't need a timestamp). Deliberately conservative in the same spirit as
// Game-Winning Buckets in the dashboard itself: undercounts before it guesses wrong.
//
// Usage:
//   node scripts/second-chance-analysis.js <export.json> [windowSeconds=20]

const fs = require("fs");
const path = require("path");

function sameTeam(game, idA, idB) {
  return (game.teamA.includes(idA) && game.teamA.includes(idB)) ||
    (game.teamB.includes(idA) && game.teamB.includes(idB));
}

// Every offensive rebound in the export, paired with whether it converted within the window —
// one row per OREB, not per game, so the caller can both tally per-player totals and (if it
// ever matters) go back to which specific game/shot a given rebound came from.
function findOffensiveRebounds(state, windowSeconds) {
  const rebounds = [];
  (state.games || []).forEach(game => {
    const events = game.scoringEvents || [];
    events.forEach(ev => {
      if (ev.made === false && ev.rebounderId && sameTeam(game, ev.scorerId, ev.rebounderId)) {
        const hasTimestamp = ev.videoTime !== null && ev.videoTime !== undefined;
        let converted = false;
        if (hasTimestamp) {
          const windowStart = ev.videoTime;
          const windowEnd = ev.videoTime + windowSeconds;
          converted = events.some(cand => {
            if (cand === ev) return false;
            if (cand.made === false) return false;
            if (cand.videoTime === null || cand.videoTime === undefined) return false;
            if (cand.videoTime < windowStart || cand.videoTime > windowEnd) return false;
            return cand.scorerId === ev.rebounderId || cand.assistId === ev.rebounderId;
          });
        }
        rebounds.push({ gameId: game.id, rebounderId: ev.rebounderId, hasTimestamp, converted });
      }
    });
  });
  return rebounds;
}

function computeStats(rebounds) {
  const stats = new Map(); // playerId -> { oreb, converted, noTimestamp }
  rebounds.forEach(r => {
    if (!stats.has(r.rebounderId)) stats.set(r.rebounderId, { oreb: 0, converted: 0, noTimestamp: 0 });
    const s = stats.get(r.rebounderId);
    s.oreb++;
    if (r.converted) s.converted++;
    if (!r.hasTimestamp) s.noTimestamp++;
  });
  return stats;
}

function formatTable(rows) {
  const nameWidth = Math.max(6, ...rows.map(r => r.player.length));
  const lines = [];
  lines.push(
    "Player".padEnd(nameWidth) + "  " + "OREB".padStart(5) + "  " + "Conv".padStart(5) + "  " + "Rate".padStart(7)
  );
  lines.push("-".repeat(nameWidth) + "  " + "-".repeat(5) + "  " + "-".repeat(5) + "  " + "-".repeat(7));
  rows.forEach(r => {
    const rateStr = r.rate === null ? "—" : r.rate.toFixed(1) + "%";
    lines.push(
      r.player.padEnd(nameWidth) + "  " + String(r.oreb).padStart(5) + "  " + String(r.converted).padStart(5) + "  " + rateStr.padStart(7)
    );
  });
  return lines.join("\n");
}

function main() {
  const [, , filePath, windowArg] = process.argv;
  if (!filePath) {
    console.error("Usage: node second-chance-analysis.js <export.json> [windowSeconds=20]");
    process.exit(1);
  }
  const windowSeconds = windowArg !== undefined ? Number(windowArg) : 20;
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    console.error("windowSeconds must be a positive number");
    process.exit(1);
  }

  const resolvedPath = path.resolve(filePath);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (err) {
    console.error(`Couldn't read/parse ${resolvedPath}: ${err.message}`);
    process.exit(1);
  }

  const players = new Map((state.players || []).map(p => [p.id, p.name]));
  const rebounds = findOffensiveRebounds(state, windowSeconds);
  const stats = computeStats(rebounds);

  const rows = [...stats.entries()]
    .map(([playerId, s]) => ({
      player: players.get(playerId) || playerId,
      oreb: s.oreb,
      converted: s.converted,
      noTimestamp: s.noTimestamp,
      rate: s.oreb > 0 ? (s.converted / s.oreb) * 100 : null
    }))
    .sort((a, b) => b.oreb - a.oreb || b.rate - a.rate);

  console.log(`Second-chance conversion — window: ${windowSeconds}s, ${rebounds.length} offensive rebound(s) across ${(state.games || []).length} game(s)\n`);

  if (rows.length === 0) {
    console.log("No offensive rebounds found in this export.");
    return;
  }

  console.log(formatTable(rows));

  const totalNoTimestamp = rows.reduce((sum, r) => sum + r.noTimestamp, 0);
  if (totalNoTimestamp > 0) {
    console.log(`\n${totalNoTimestamp} offensive rebound(s) had no videoTime on the missed shot and couldn't be checked for conversion (still counted toward OREB, never toward conversions or rate).`);
  }
}

main();
