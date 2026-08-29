# Integration notes for Adam

This is a handoff brief for whoever (human or Claude) wires this dashboard into
poolean.adammirmina.com. It assumes zero prior context on this tool.

## What this is

A static HTML/CSS/JS dashboard (`index.html` + `style.css` + `app.js`, no build step, no
dependencies) that Ben uses to sit down with game video and log box score stats, "who scored on
who" for each basket, defensive matchups, and highlight/lowlight clip timestamps. Right now
everything is stored client-side only:

- **`state` object** (players, games, stats, scoring events, matchups, reel clips, session
  videos) — persisted to `localStorage` under the key `poolLeagueStatTracker`.
- **Video files** the user picks locally — persisted to **IndexedDB** (`poolLeagueVideos` /
  `videos` store). A game with its own video is keyed by that game's id; a video shared across
  several games (a single recording covering a whole session) is keyed by a separate master
  video id instead, referenced from every game that uses it (see `masterVideoId` below) — so the
  file is only stored once no matter how many games play from it. Either way these never leave
  the browser — there is currently no upload/hosting step for video at all.

`poolean-seed.json` in this folder is a one-time export from `pooleansummer2026season.xlsx`
(itself pulled from the live PocketBase) — it seeds the local `state.players` and `state.games`
so ids already line up with your `SLUG` / `GAME_ID` values. See below for why that matters.

## The ask

Replace (or supplement) the `localStorage` persistence with real writes to your PocketBase
instance, so this data lands in the same backend as the rest of Poolean instead of staying
trapped in one browser.

## Current data model

Full shape is documented in `README.md` under "Data schema (JSON)". Summary:

```
players: [{ id, name }]
masterVideos: [{ id, name, fileName }]  // metadata only — the actual file lives in IndexedDB
games: [{
  id, date, notes, videoUrl, winner: "A"|"B"|null,
  masterVideoId: id | null, videoStart: number, videoEnd: number | null,  // shared recording + this game's [start, end) within it — null end means "runs to the end of the recording"
  teamA: [playerId], teamB: [playerId],
  stats: [{ playerId, pts, oreb, dreb, ast, stl, blk, tov, pf }],  // every one of these is derived, see below
  scoringEvents: [{ id, scorerId, points, made, assistId: id | null, defenderIds: [id], blockerId: id | null, turnoverEventId: id | null, rebounderId: id | null, shotLocation: { x: number, y: number } | null, videoTime: number | null }],
  turnoverEvents: [{ id, playerId, opponentId: id | null, stealEventId: id | null, missEventId: id | null, videoTime: number | null }],
  stealEvents: [{ id, playerId, opponentId: id, videoTime: number | null }],  // opponentId required — a steal always has a victim
  foulEvents: [{ id, playerId, opponentId: id | null, videoTime: number | null }],
  matchups: [{ id, defenderId, offenderId, note, videoTime: number | null }],  // general "guarding who" log
  plays: [{ id, type: "highlight"|"lowlight", start, end, playerId | null, note }]
}]
```

Important: **every field in `stats` is derived, not authoritative — there is no longer a single
manually-clicked counter anywhere in the box score.** `pts`/`ast`/`blk`/`oreb`/`dreb` all come
from `scoringEvents`, `tov`/`stl`/`pf` from `turnoverEvents`/`stealEvents`/`foulEvents`,
recomputed every time those change (see `recomputeDerivedStats()` in `app.js`). If you sync
those event collections to PocketBase, all eight `stats` numbers should be a query/aggregate
over them, not separately-synced fields, or they'll drift.

**`scoringEvents[].assistId` is only meaningful when `made: true`** — a missed shot can't be
assisted, so the app never sets it on one; treat `assistId` on a `made: false` row as
meaningless if you ever see it (shouldn't happen from this tool, but don't build server-side
validation that assumes it can't). Symmetrically, **`blockerId` and `rebounderId` are only
meaningful when `made: false`** — a block or a rebound both require a miss to have happened.
`rebounderId` is additionally never set when `turnoverEventId` is set (an out-of-bounds miss is
a dead ball, not a live rebound). Whether a rebound counts as `oreb` or `dreb` isn't stored on
the row at all — it's derived by comparing the rebounder's team to the shooter's (`sameTeam()`
in `app.js`): same team is offensive, the other team is defensive.

**`scoringEvents[].defenderIds` is an array, not a single value** — a shot can be double-teamed,
and each tagged defender gets full credit in their own defensive stats (not split between them),
so summed across all defenders in a game, points-allowed-style totals can exceed the game's
actual score. That's expected, not a bug. `turnoverEvents`/`stealEvents`/`foulEvents.opponentId`
are singular by contrast — those events only ever involve one other player.

**A missed shot ruled out of bounds is also a turnover, written the same atomic way a steal
is.** Poolean's actual rule is that whoever last touched the ball loses possession, so a miss
that goes out of bounds costs the shooter possession. Marking a miss that way when logging it
creates a `turnoverEvents` row with `missEventId` pointing back at the `scoringEvents` row (and
that row's own `turnoverEventId` pointing back at the turnover) — `opponentId` on that turnover
is the blocker if there was one, else the lone contesting defender if there was exactly one,
else null. Same lockstep-deletion rule as steals: removing the shot removes its linked turnover;
removing the turnover just clears `turnoverEventId` back to null on the shot (the shot itself
isn't deleted).

**A steal always implies a turnover, and the tool enforces that at write time rather than
leaving it to be inferred later.** Logging a steal creates two linked records in one action: the
`stealEvents` row, and a `turnoverEvents` row for the victim with `opponentId` set to the
stealer and `stealEventId` pointing back at the steal (`commitTaggedEvent()` in `app.js`). A
turnover logged directly — the more common case: travels, bad passes, offensive fouls, anything
without a clean steal — has `stealEventId: null`. Deleting either half of a linked pair deletes
both (`removeTaggedEvent()`), so they can't drift apart. If you replicate this server-side,
keep that same write-both-atomically behavior rather than trying to derive one from the other
after the fact — a turnover row with no matching steal is a legitimate, common state, so you
can't tell "no steal happened" apart from "the link broke" without the explicit
`stealEventId` field.

**`winner` is also a fallback, not authoritative once real data exists — but it only ever
resolves one game's own result, not the season aggregate.** A single game's own W/L (shown on
its own scoreboard, and per-row in a player's Game Log) is computed by `playerGameResult()`: if
`scoringEvents` has any entries for that game, the actual summed score decides the result; only
if it's empty does `winner` (imported from the original spreadsheet's `WINNER` column, see
`poolean-seed.json`) get used instead; if neither exists, that game just doesn't have a result
yet. If you build a `games.winner` field in PocketBase, replicate this same precedence rather
than trusting `winner` unconditionally — otherwise a game whose video has been reviewed and
scored will show the wrong result once corrected data conflicts with the import.

**The season-wide W-L record on the Leaderboard is narrower than that, though**:
`computeLeaderboard()` only counts a game toward `gp` — and therefore toward wins/losses/ties
and every rate stat — when `scoringEvents.length > 0`. A game resolved only via the `winner`
fallback contributes its result to that game's own row (Game Log), but not to the season
aggregate, until it's actually reviewed. If you replicate a season W-L / rate collection
server-side, filter on the same condition rather than including every game `winner` can resolve
— otherwise an unreviewed imported game would pad a player's record without contributing any of
the box-score detail its rate stats are supposed to represent.

## Player and game ids already match your PocketBase

`player.id` in this tool equals your `players.SLUG`, and `game.id` equals your `games.GAME_ID` —
`poolean-seed.json` was built directly from those columns. So a `scoring_events` row that says
`game: "cknukdz3day7umy", scorer: "ben"` should join cleanly against your existing `games` and
`players` collections with no id-mapping step.

## Open question: team rosters may already exist in your backend

Your season export includes a `game_players_long` sheet (`GAME_NO, DATE, SLUG, NAME, TEAM,
WON`), which strongly suggests you already have a collection recording which team each player
was on, per game. This dashboard's `teamA` / `teamB` arrays duplicate that same information —
Ben assigns them by hand per game (necessary right now since this tool has no read access to
your backend). **Worth checking before building anything**: if you already have that data, it's
probably better for this tool to *read* team assignments from PocketBase (so Ben doesn't have to
re-enter them) rather than writing a second, possibly-conflicting copy. If you don't already
persist it in a form other collections can join against, then `teamA`/`teamB` as entered here is
the source of truth and should sync outward.

## Proposed new PocketBase collections

No schema exists yet for stats/matchups/clips, so here's a proposal — change field names/types
to match your conventions, this is a starting point, not a spec to follow literally:

**`box_score_stats`** (or compute every field on the fly from the event collections below
instead of storing them — that's what the dashboard itself does; there's no field here that
isn't derivable from `scoring_events`/`turnover_events`/`steal_events`/`foul_events`)
- `game` → relation to `games`
- `player` → relation to `players`

Everything below this — shooting splits, eFG%, TS%, Stocks (STL+BLK), Pts Allowed, Opp FG%,
Beaten, Stops, Game Score, Two-Way Score — is *computed* from `box_score_stats` + `scoring_events`
(+ the turnover/steal/foul event collections for TOV/STL/PF specifically), not stored anywhere.
See `shootingStats()`, `gameDefenseStats()`, `trueShootingPct()`, `effectiveFgPct()`,
`gameScore()`, `defensiveImpact()`, and `twoWayScore()` in `app.js` for the exact formulas if you
want to replicate them as PocketBase views/queries instead of recomputing client-side.

**Two-Way Score is GmSc plus Defensive Impact** (`defensiveImpact()`): `Stops − Beaten −
0.4×Pts Allowed`, using the same per-shot defender tags as Pts Allowed/Beaten/Stops above — no
new stored data. Stops and Beaten are weighted symmetrically at 1.0 (a stop denies a possession
the way GmSc weights a steal), Pts Allowed at 0.4 so a 3-point beat scores worse than a 2-point
beat without double-penalizing the same possession the Beaten count already covers, and Opp FG%
deliberately isn't its own term since it's just Beaten ÷ (Beaten + Stops) — a separate term
would double-count that. **A player never tagged as a defender in a game has Stops, Beaten, and
Pts Allowed all at 0, so Defensive Impact is exactly 0 for them, not a penalty** — this matters
because Ben's tagging policy is to only tag a defender when it's genuinely clear from the video,
so conservative tagging should never hurt a Two-Way Score. If you replicate this server-side,
make sure a "no tagged defensive possessions" player computes to 0, not null/undefined that then
propagates as NaN or gets treated as a bad defensive game.

**Every counting stat on the Leaderboard page — not just PTS/20 and GmSc/20 — is normalized per
20 combined points scored in the game, not per game and not a season total**: PTS, OREB, DREB,
AST, STL, BLK, TOV, PF, Pts Allowed, Beaten, Stops, Def Impact, GmSc, and Two-Way, plus the
FG/3PT/FT makes-attempts shown. See `gameTotalPoints()` and the `per20()` closure in
`computeLeaderboard()` in `app.js`. This matters uniformly, not just for points and Game Score,
because games are capped at different targets (16 or 21), so a per-game average isn't directly
comparable across games; the combined final score is used as a stand-in for possessions/pace,
which this tool doesn't track directly. Keep this normalization if you replicate these stats
server-side, rather than switching to a naive per-game average — and apply it to every counting
stat, not a subset. A/TO and the shooting percentages are untouched by this, since they're
already ratios.

**Only a game with `scoringEvents.length > 0` counts toward a player's `gp` (and therefore every
rate above) at all.** A game that's just been rostered — or one that only carries a historical
`winner` imported with no shot-level detail, see the `winner` section above — has nothing to
normalize a rate from, so counting it would drag every rate toward 0 for a game nobody's
reviewed yet. `computeLeaderboard()` filters on this before computing anything else.

The Leaderboard CSV export is a separate code path and still exports raw season totals plus
`games_played` (over that same stats-logged-only game set) rather than per-20 rates for every
column — it only computes PTS/20, GmSc/20, and Two-Way/20 directly, same three as before. If
you're pulling from the CSV (or replicating a season-totals collection) rather than scraping the
rendered page, you have the totals; apply the same per-20 normalization yourself for whatever
rate you want to show, same as the dashboard's own UI layer does.

**`scoring_events`** — one row per shot attempt, made or missed (this is what the dashboard
calls the "Shot Log")
- `game` → relation to `games`
- `scorer` → relation to `players` (the shooter, make or miss)
- `points` → number — the *attempted* value: 1 = free throw, 2 or 3 = field goal. For a miss
  this is what it would have been worth, not what was scored.
- `made` → boolean. `false` = miss. A record with this field entirely absent (from data
  generated before misses existed) should be treated as `made: true`.
- `assist` → relation to `players`, nullable, **single** (one teammate credited, or none) —
  only meaningful when `made: true`; a miss can't be assisted.
- `defenders` → **multi**-relation to `players` (a shot can be double-teamed — this is not a
  single nullable relation). Empty = no defender / open shot, a deliberate, meaningful state,
  not missing data. Each player in the relation gets full credit for the shot in their own
  defensive stats, not a split share, so summing points-allowed-style numbers across all
  defenders in a game can legitimately exceed the game's actual score.
- `blocker` → relation to `players`, nullable, **single** — the one opponent who blocked it;
  only meaningful when `made: false`. `blk` in `box_score_stats` (or wherever you land on
  storing it) should be a count of `scoring_events` rows where a player is the `blocker` on a
  `made: false` row — same derivation principle as `assist`/`pts`.
- `turnover` → relation to `turnover_events`, nullable — set when this miss was ruled out of
  bounds (see below), null otherwise.
- `rebounder` → relation to `players`, nullable, **single** — the one player (either team) who
  grabbed it; only meaningful when `made: false` and `turnover` is null (an out-of-bounds miss
  is a dead ball, never rebounded). Whether this counts as `oreb` or `dreb` isn't a separate
  field — derive it by comparing the rebounder's team to the scorer's for that game (same team =
  offensive, other team = defensive), same as `sameTeam()` does client-side.
- `shot_x`, `shot_y` → number, nullable, each 0-100 — where the shot was marked on the shot
  chart (`y: 0` at the hoop, `y: 100` at the far wall; `x` across the court's width), or both
  null if unmarked. Only ever set when `points` is 2 or 3 — never on a free throw, which has no
  location on the floor. The 0-100 scale is a percentage of the court, not feet — if you render
  your own version of the chart, use the pool's actual proportions (~30ft end to end by ~15ft
  wide, a 2:1 ratio) rather than a square, to match what this tool's own diagram looks like.
  **This is purely informational and never overrides `points`** — the
  dashboard doesn't derive or correct 2-vs-3 from where you clicked, it just flags a mismatch
  with a badge in its own Shot Log UI. Don't build server-side validation that rejects a
  `made`/`points` combination because it disagrees with `shot_y` relative to the 60%-depth 3pt
  line; a flagged mismatch is a real, if imprecise, spot marked slightly off from the actual
  line, not invalid data.

Shooting splits (FG/3PT/FT %) and the defensive numbers below are *computed* from this one
collection, not stored anywhere separately — see `shootingStats()` and `gameDefenseStats()` in
`app.js` for the exact logic (points-allowed and "beaten" only count `made: true` rows against a
defender; a contested miss counts as a "stop" instead).

**The Close / Midrange / Line / Deep shot-distance split is also purely computed, nothing
stored — a further breakdown of `shootingStats()`'s existing `fgm`/`fga`/`tpm`/`tpa`, not a new
field on `scoring_events`.** The motivating finding, originally for 3PT only: a season's worth
of 3PT attempts, split by radial distance from the hoop, showed a real gap between shots just
past the line (a normal, makeable three) and much-longer near-pool-length heaves (a different,
far lower-percentage shot) — a single blended "3PT%" was quietly averaging the two together,
making the line three look worse than it is and the heave look better. The same idea was later
extended one zone closer to the hoop, splitting the 2PT bucket into Close and Midrange too.
Compute (`shotBand()` in `app.js`):

```
distance = sqrt((shot_x - 50)^2 + (shot_y - 0)^2)   // hoop is always at (50, 0) in this coordinate space
band = points === 3
  ? (distance > THREE_PT_DEEP_THRESHOLD ? "deep" : "arc")     // threshold currently 80 — displayed as "Line," returns "arc" internally
  : (distance > CLOSE_RANGE_THRESHOLD ? "mid" : "close")       // threshold currently 30, only applies to points === 2
```

Both thresholds (`app.js`) are single, easy-to-find constants, not settled rules or per-user
settings. `THREE_PT_DEEP_THRESHOLD` was drawn from a small early sample (41 total 3PT attempts
league-wide when it was introduced) and is expected to move as more games get logged.
`CLOSE_RANGE_THRESHOLD` is a rougher starting guess with no comparable shot-volume analysis
behind it at all yet — treat it as even more provisional than the 3PT threshold, and don't be
surprised if it needs to move sooner. If you replicate this server-side, keep both similarly easy
to change in one place rather than hardcoding them into a query, and don't build anything (UI
copy, alerts) that treats a player's per-band split as a settled number while the sample is still
this small — especially true for the 2PT split. Only rows with a non-null `shot_x`/`shot_y` get
banded — an unmarked attempt still counts toward the plain `fgm`/`fga`/`tpm`/`tpa`, just not
toward any band (same "unmarked shots are excluded, not zero" pattern as the heatmaps below).
Deliberately **not** inlined as extra columns on the main Leaderboard table, Game Stats table,
Player Game Log, or the Head-to-Head tables — an earlier pass did exactly that (for the 3PT-only
version) and it read as clutter on tables that already carry 20+ columns, so it lives in its own
supplementary panel below the main Leaderboard table instead (**Shot Distance**,
`renderThreePtDistancePanel()` in `app.js` — the function name predates the 2PT extension and
wasn't renamed, same "not worth the churn" call as `shotBand()`'s internal `"arc"` value), the
same pattern Assist Connections and Teammate Synergy already use for "useful but secondary" cuts.
`shooting.closeM/A`, `midM/A`, `tpArcM/A`, and `tpDeepM/A` are all present on every
`computeLeaderboard()` row (and exported in the Box Score/Leaderboard CSVs; the Shot Log CSV's
`shot_band` column covers all four values plus blank) — only the *inline table* placement was
ever pulled back, not the underlying computation. The 2PT/3PT boundary itself (the actual 3pt
line, `y: 60`) is untouched by any of this — both splits only ever subdivide shots already
inside their own bucket, never move a shot across the 2PT/3PT line itself.

**Out-of-Bounds Misses on the Leaderboard is also purely computed, nothing stored.**
`computeOutOfBoundsStats()` counts, per player, `scoring_events` rows where `made: false`
(misses only — a make can never go out of bounds), and how many of those also have `turnover`
set (see the out-of-bounds rule described near the top of this section). The rate is
`turnover-set misses / all misses` for that player, not `/ all attempts` — the denominator is
deliberately scoped to misses since a make is never a candidate for this at all, so mixing makes
into the denominator would just dilute the number with shots that couldn't have gone out of
bounds in the first place. A league-wide version of the same rate (summed across every player)
renders above the per-player table for context.

**Second-Chance Conversion on the Leaderboard is also purely computed, nothing stored — and is
kept deliberately identical to a standalone script, not just similar to it.**
`computeSecondChanceConversions()` (`app.js`) and `scripts/second-chance-analysis.js` (repo
root) implement the exact same algorithm on purpose: an offensive rebound is a `made: false`
`scoring_events` row with `rebounder` on the shooter's own team (`sameTeam()`); it counts as
*converted* if, within `SECOND_CHANCE_WINDOW_SECONDS` (currently 20) of that row's own `at`
timestamp, some other made row in the same game has `scorer` equal to the rebounder or `assist`
equal to the rebounder — either path counts once. Both the miss and the candidate make need a
non-null `at` to be evaluated; a miss without one still counts toward OREB but is excluded from
the conversion check (and tallied separately as "couldn't be checked"). The window's inclusive
on both ends. The script exists because this is genuinely useful run against an arbitrary
exported file (someone else's export, an older season) without that data being loaded into a
live browser session at all — if you ever build an equivalent on your side, replicate the
"require a real timestamp on both ends, don't infer order from anything else" rule exactly the
same way Game-Winning Buckets does, for the same reason: a wrong conversion attribution here is
worse than an undercounted one.

**Awards vs. Stats on the Leaderboard is a different case from everything else in this
section: half of it is genuinely hardcoded, not computed.** `AWARD_RESULTS` (`app.js`) is a
fixed snapshot of Summer 2026's closed award ballot (`award_results` in the season's own
spreadsheet export) — winners by player slug, one entry per award. That part is **not** derived
from anything in `state` and won't update itself; it's a historical record of a vote that
already happened. What *is* computed live, every render, is each winner's standing on whichever
tracked stat `computeAwardsVsStats()` pairs with that award — Two-Way/20 rank for most of them,
**season-long total Two-Way** (not a rate — see `twoWayTotal` on `computeLeaderboard()`'s
per-player object) specifically for MVP, Def Impact/20 rank for DPOY, Game-Winning Buckets for
Clutch (see below), the Last 5 trend for Most Improved (`last5TwoWayPer20` vs. `twoWayPer20`,
same mechanism as the Leaderboard's own Last 5 column but Two-Way instead of GmSc here), or the
average Two-Way/20 lift a "Best Teammate" winner gives their actual teammates, reusing
`computeTeammateSynergy()` from the section above — same "nothing stored, always current"
pattern as the rest of this page. If you add a new season's awards, that means editing
`AWARD_RESULTS` by hand (or building a real `award_results` collection and reading from it) —
there's no mechanism here that pulls it from anywhere automatically. Winner slugs are matched
against `player.id` exactly like `poolean-seed.json` (see "Player and game ids already match
your PocketBase" above); a slug with no matching player renders as "not in current roster"
rather than erroring, which covers both a genuinely-absent player and one Ben simply hasn't
added to this browser's roster yet — the UI can't tell those two cases apart, and doesn't try to.
`computeAwardStandings()` builds the same underlying ranking one level up — full standings per
statKey (every qualifying player, not just the award's own winner(s)) — which
`computeAwardsVsStats()` both slices down to a single winner's rank/value and exposes in full as
each award's `standings` array; the UI renders that behind a per-card "See standings" toggle
(`expandedAwards`, a plain in-memory `Set` of expanded award keys — UI state, not app data, and
not persisted across a reload).

**Each award's `votedStandings` array is a second, entirely separate hardcoded snapshot from
the same season spreadsheet — the real ballot tally, not something this tool derives.** Sourced
from `award_tally_long`'s `borda_points` measure (`pair_votes` for `best-duo`/`worst-duo`, which
aren't single-candidate ballots) — every candidate who received at least one vote, with their
point total, in the exact order that actually decided the award. Unlike everything else on this
page, `votedStandings` entries carry their own `name` directly (not resolved through
`state.players`), since a vote tally is a historical fact independent of who happens to be in
the current browser's roster — Logan H, Kayla, Ian, and others who received votes were never
imported into `poolean-seed.json` at all, and that's fine; the vote list still shows them
correctly by name. When the UI expands an award, it renders `votedStandings` ("How the vote
went") side by side with the live `standings` array ("Stat standings") — the entire point of the
panel is comparing a fixed historical vote against a live-computed number, so don't try to
reconcile or merge the two into one list if you port this; keeping them visibly separate is
intentional. If a future season's awards get added, `votedStandings` needs the same manual-entry
treatment as `AWARD_RESULTS.winners` — there's no live connection to a ballot system here at all.

**Power Ranking vs. Performance is the same "half hardcoded, half live" shape as Awards vs.
Stats, one level down: per-night instead of per-season.** `PARTY_RANKINGS` (`app.js`) is a frozen
snapshot of `rankings_long` from the season spreadsheet — your own site's per-party rank and
field-size-normalized percentile for every player at every party, the same numbers your "season
average" already averages over. That part is hardcoded and won't update itself, exactly like
`AWARD_RESULTS`. `PARTY_RANKINGS` itself only carries 5 of the real 15 parties — the ones with
`date` values matching games that actually exist in `poolean-seed.json` (2026-07-29, 08-02,
08-05, 08-10, 08-16) — since the other 10 parties predate any game footage existing at all, and
"performance on the night" has nothing to compute for them. On top of that, the rendered list is
filtered further, live: `computePowerRankingVsPerformance()` drops any party where every player's
`perf` came back null — i.e., a night with footage that just hasn't been reviewed yet renders
nothing rather than a table of dashes, same "don't show an all-empty state" call the other panels
make. What's live for a party that *does* show: `games` filtered to that exact `date` with
`scoring_events.length > 0`, further filtered to just the games that specific player's
`teamA`/`teamB` includes (a party can have more than one game, and a player may not have played
in all of them), run through `computeRateSummaryForGames()` — the same helper Teammate Synergy
above uses — for that player's Two-Way/20 in just that night's games. A player with no qualifying
game that night renders "—", not a zero, same reasoning as everywhere else non-participation
isn't a bad performance. If you add parties 6-10 here (or a future season's), you'd need both the
`date`-to-party mapping and, eventually, actual footage for "performance" to mean anything for
them.

**Game-Winning Buckets is also purely computed, nothing stored** — a season count, per player,
of games where `gameWinningShot()` (`app.js`) identified their shot as the one that actually
closed out a game their team won. The logic: find the winning team (higher final score; a tie
has no winning shot at all), then require that *every* `made: true` row in that game's
`scoring_events` has a non-null `video_time` — if even one make lacks a timestamp, the whole game
is skipped, since an untimed shot could have happened at any point in the game and a partial set
of timestamps can't reliably establish which specific shot was really last. Only among fully
timestamped games does the chronologically-last make (by `video_time`) count, and only if it
belongs to the winning team. This is a real precision-over-recall tradeoff, not a UI nicety: a
game logged without full timestamps will never contribute a Game-Winning Bucket, even if a human
watching would know exactly which shot won it. If you replicate this server-side, keep that same
all-or-nothing timestamp requirement per game rather than falling back to insertion order for the
untimed rows — insertion order is not guaranteed to reflect game order once backfill/edit
workflows are involved, and a wrong "winning shot" attribution would be worse than none at all
here specifically, since it feeds directly into a voted award comparison.

**The heatmaps on Player Detail and the Leaderboard are also purely computed, nothing stored.**
They bucket every field goal with a non-null `shot_x`/`shot_y` into a 5×6 grid over the court
(`computeHeatmapCells()` in `app.js`), color each occupied cell by that zone's FG%, and label it
with attempts. Deliberately coarse — with a season split across dozens of players, a finer grid
mostly produces single-shot cells reading as a meaningless 0% or 100%. If you build an
equivalent view, two behaviors worth replicating exactly:
- A cell with zero attempts renders as nothing (not a 0%-red cell) — "no data" and "shot 0%" need
  to stay visually distinct.
- The 6 rows are **not** evenly spaced (`HEATMAP_ROW_BOUNDARIES` in `app.js`:
  `[0, 15, 30, 45, 60, 80, 100]`) — one boundary lands exactly on `y: 60`, the same 3pt threshold
  the mismatch badge uses (see `shot_x`/`shot_y` above), so a zone never straddles the line and
  blends a 2PT FG% together with a 3PT one. 4 tighter rows inside the arc, 2 looser ones beyond
  it, matching where shot volume actually concentrates. If you resize the grid, keep a boundary
  on 60 rather than going back to uniform rows.

**Assist Connections on the Leaderboard, and Teammate Synergy on Player Detail, are also purely
computed, nothing stored.** Deliberately *not* a win/loss duo table — the real site already has
that.

`computeAssistConnections()` walks every `scoring_events` row with a non-null `assist` on a make,
and tallies `(assister, scorer)` pairs — directional, since Alice assisting Bob is a different
fact from Bob assisting Alice. This is a straight readout of data already in `scoring_events`,
nothing new to store.

`computeTeammateSynergy(playerId)` is per-player, not league-wide: for each teammate this player
has shared `teamA`/`teamB` with (in a game with `scoring_events.length > 0`), it splits that
player's *own* games into "with" that teammate on their side vs. "without" (teammate on the other
team, or not in that game), and compares GmSc/20 and Two-Way/20 across the split using the same
per-20 math as `computeLeaderboard()` — see `computeRateSummaryForGames()` in `app.js`. This is
the closer thing to a real "synergy" signal (does this player's own output change with a given
teammate on the floor) than a duo's shared win/loss record ever was, but it needs a real sample on
both sides of the split to mean anything — a teammate this player has *always* played with has no
"without" games to compare against, which the UI shows as "—" rather than a misleading 0.0.

**`turnover_events`**, **`steal_events`**, **`foul_events`** — one row per occurrence, same shape
for all three
- `game` → relation to `games`
- `player` → relation to `players` (who committed the turnover/steal/foul)
- `opponent` → relation to `players`, **single** (not multi like `scoring_events`'s
  `defenders` — a turnover/steal/foul only ever involves one other player: who
  forced/recovered the turnover, who it was stolen from, or who was fouled). **Required** on
  `steal_events` (a steal always has a victim); **nullable** on the other two.
- `turnover_events` only: `steal` → relation to `steal_events`, nullable — set when this
  turnover was created *by* a steal (see below), null for a turnover logged directly or from an
  out-of-bounds miss.
- `turnover_events` only: `miss` → relation to `scoring_events`, nullable — set when this
  turnover was created *by* a missed shot ruled out of bounds, null otherwise. At most one of
  `steal`/`miss` should ever be set on a given row.

**The Leaderboard's "Last 5" column is also purely computed, nothing stored.** It's the same
per-20 GmSc math as the season column, just scoped to a player's 5 most recent games with
`scoring_events.length > 0` (by `date`, not insertion order — sort descending and slice first),
via `computeRateSummaryForGames()` reused from Teammate Synergy above. The ▲/▼/– trend arrow
compares that windowed GmSc/20 against the player's season GmSc/20, with anything inside ±0.5
treated as flat (`●`, not a dash — a dash next to a number reads as a minus sign) rather than a
real trend. Not included in the Leaderboard CSV export,
matching that export's existing scope (raw season totals plus PTS/GmSc/Two-Way per 20 — see
above), not a mirror of every UI column.

**The "Needs Review" badge and backlog count on the Games tab are also pure UI, nothing stored.**
A game counts as needing review when it has a video attached (`video_url`, `master_video_id`, or
a locally-stored file — see `getAllStoredVideoIds()` in `app.js`) **and**
`scoring_events.length === 0`. A game with no video at all is deliberately excluded — there's
nothing to review yet, so it shouldn't pad the backlog count the same way an unreviewed-but-
watchable game does.

**The "OUT" badge on a fouled-out player is pure UI, nothing stored or derivable-only-once.**
Poolean's actual rule is 3 fouls ejects a player for the rest of that game; the dashboard just
checks `pf >= 3` (`FOUL_OUT_THRESHOLD` in `app.js`) wherever it renders a PF cell — there's no
`fouled_out` field anywhere, since `pf` is already a `foul_events` count per the derivation rule
above.

**A steal always implies a turnover, and so does a miss ruled out of bounds — write both
atomically in either case, don't try to derive one from the other later.** Creating a
`steal_events` row should also create the matching `turnover_events` row (`player` = the victim,
`opponent` = the stealer, `steal` = the new steal's id) in the same operation, and deleting
either should delete both. Marking a `scoring_events` row as out-of-bounds should likewise create
a `turnover_events` row (`player` = the shooter, `opponent` = the blocker if any else the lone
defender if there was exactly one else null, `miss` = the shot's id) and set that shot's
`turnover` field to point back at it; deleting the shot deletes its linked turnover, but deleting
just the turnover should only clear the shot's `turnover` field, not delete the shot. A
`turnover_events` row with both `steal` and `miss` null is a legitimate, common case (travels,
bad passes, offensive fouls — anything without a clean steal or an out-of-bounds miss), not a
broken link, so don't treat every unlinked turnover as an error.

TOV/STL/PF in `box_score_stats` (or wherever you land on storing them) should be a count of
these rows per player per game, not hand-entered — same derivation principle as `pts` and
`ast` (a count of `scoring_events` rows where this player is the `assist` on a `made: true` row).

**`matchups`** — general defensive assignment log, separate from `scoring_events`
- `game` → relation to `games`
- `defender` → relation to `players`
- `offender` → relation to `players`
- `note` → text, optional (e.g. "Q1", "2nd half")

**`highlight_reel`**
- `game` → relation to `games`
- `type` → select: `highlight` | `lowlight`
- `start`, `end` → number (seconds into the source video)
- `player` → relation to `players`, nullable
- `note` → text, optional

## Open question: where does the actual video live?

This dashboard never uploads video anywhere — Ben loads a local file that plays only in his own
browser (IndexedDB), or pastes a URL. `highlight_reel.start`/`end` are timestamps *into whatever
video file was loaded for that game* — they're meaningless without knowing which file that is.
Before `highlight_reel` is useful on the live site, you need a real video hosting story (upload
to PocketBase file storage, S3, an unlisted YouTube upload, etc.) and a way to tie a game to
*that* hosted file's URL — at which point these timestamps apply directly to it, assuming it's
the same source video Ben scrubbed through.

**`masterVideos[].fileName` exists specifically to resolve this.** `masterVideoId` is this
tool's own local id — it will never match a row in whatever recordings table you build, so an
import needs some other signal to know which of your hosted recordings a game's shots belong to,
especially on a night with more than one recording (rosters and final score alone won't
disambiguate two recordings from the same night with the same players). `fileName` is the
original uploaded file's name (e.g. `"IMG_2769.MOV"`), captured once at upload and never edited
after — unlike `name`, which Ben can freely retype to something generic like "Aug 10 games" and
lose the one thing that told two same-night recordings apart. Match `fileName` against whatever
you host that file as (or ask Ben to confirm, if it's ambiguous even then) rather than trusting
`masterVideoId` to resolve, and rather than silently guessing when a game's rosters/winner match
more than one candidate recording — a wrong match here writes successfully and reads as
plausible, so nothing later catches it.

**A single-game JSON export now embeds the relevant `masterVideos` entry inline, as
`masterVideo`.** It didn't originally — a single-game export dumped only the bare `games` row,
with no sibling `masterVideos` array to resolve `masterVideoId` against (unlike the full
"export all data" dump, which has one at the top level), so `fileName` never actually reached
anyone importing one game at a time. If you're parsing single-game exports specifically, read
the recording's name/fileName from `masterVideo` on the export itself (`{ id, name, fileName }`,
or `null` if that game isn't on a session video) rather than expecting a sibling
`masterVideos` collection to exist in that file.

One more wrinkle if you build this out: several games can share **one** recording (Ben often has
a single video covering a whole session of back-to-back games) via `masterVideoId` +
`videoStart`/`videoEnd` on each game. `videoEnd` is nullable — null means "runs to the end of the
recording," which in practice usually means "the last game in that session," since there's
nothing after it to bound it. `highlight_reel.start`/`end` for a clip marked on one of those
games are timestamps into the *shared master recording* — the same coordinate space as
`videoStart`/`videoEnd`, **not** relative to them (marking a clip just reads the live playback
position of whichever video is loaded, master or per-game, with no subtraction). If you end up
hosting video per-session rather than per-game, that maps naturally onto this same structure; if
you host per-game instead, `videoStart`/`videoEnd` are exactly the cut points you'd need to slice
the shared recording into per-game files at upload time (falling back to the *next* game's
`videoStart` in the same session, or the end of the file, wherever a game's own `videoEnd` is
null) — and you'd shift that game's clip timestamps back by its `videoStart` to make them
relative to the new file, same as before this field existed.

## Theming — matching your site's look

All colors, fonts, radii, and shadows are CSS custom properties defined in one place,
**`theme.css`** (loaded before `style.css`) — nothing else in the codebase hardcodes a color or
font. `style.css` is layout/structure only, built entirely on `var(--...)` references, and
`app.js` never touches styling at all. The current palette (navy + a single teal accent, small
radius, Archivo + IBM Plex Mono) is just Ben's own working look for this tool day-to-day — not a
Poolean brand direction to preserve. Treat it the same as any other placeholder: swap it freely
to match the live site. To make this look like it belongs on poolean.adammirmina.com, you have
two options and don't need to touch `style.css` for either:

1. **Edit `theme.css` directly** — swap the hex values for your site's palette, change
   `--font-body` / `--font-display` to your site's fonts (and swap or drop the Google Fonts
   `<link>` in `index.html` if you're not using Manrope/Space Grotesk), adjust `--radius` /
   `--shadow-*` to match your components' roundedness and elevation.
2. **Layer a second stylesheet after it** that redefines the same variable names on `:root` (and
   on `:root[data-theme="dark"]` for the dark variant) — useful if you'd rather keep this file
   untouched and diffable against future updates from this tool.

If you're embedding this as a fragment inside an existing page (rather than its own route), be
aware every token is scoped to `:root`, which is global — rename the scope to a wrapper class
(e.g. `.pool-stat-tracker`) on both `theme.css`'s selectors and the container element if your
site already defines CSS variables with any of these same names, so the two don't collide.

The full token list, with what each one controls, is commented inline in `theme.css` under four
groups: Surfaces, Text, Brand + semantic colors, and Typography — read that file top to bottom
before touching anything, it's short.

## What would change in the code

Every read/write currently goes through `state` in memory, `saveState()` (writes the whole
`state` to `localStorage`), and `loadState()` (reads it back). The natural integration point is
swapping those two functions' bodies for PocketBase SDK calls (`pb.collection(...).create() /
update() / getFullList()`) — the rest of the UI code (`renderGames`, `renderBoxScore`, etc.) just
reads/mutates the in-memory `state` object and doesn't care where it came from. You'll also want:

- The PocketBase JS SDK (CDN script tag is simplest, no build step needed to match this repo).
- An auth strategy — this is presently a single-user local tool with no login screen at all.
- Incremental writes instead of one big blob: right now every stat click calls `saveState()`
  which serializes the *entire* app state to `localStorage`; against a real backend you'd want
  each action (a basket, a matchup, a clip) to write just its own record.

**A subtle bug worth knowing about if you port the video panel specifically:** every stat click
re-renders the whole Stat Entry view, including the video panel. An early version of this tool
rebuilt the `<video>`/`<iframe>` element from scratch on every single one of those re-renders —
which, with a real video loaded, means playback would silently jump back to 0:00 and pause
every time you tagged a stat, since the browser treats a fresh element as a fresh load even with
the same `src`. `renderVideoPanel()` now tracks a `renderedVideoKey` (source + game id) and only
rebuilds the actual player element when that key changes, leaving it untouched on routine
re-renders. If your integration re-implements this panel in a component framework (React, etc.),
the equivalent mistake is trivial to make by accident — e.g. keying a `<video>` on something
that changes every render, or not memoizing the element — so make sure whatever's actually
playing the video is stable across re-renders unless the source has genuinely changed. This is
also why `videoTime` capture is trustworthy: it reads `currentTime` off that same stable element
at the moment an event is logged, not off a freshly-reset one.

**One more thing worth knowing: `videoTime` is deliberately not the exact instant the event was
logged — it's backed up 5 seconds (clamped at 0), since you're always clicking a moment after the
play actually happened.** `currentPlaybackTime()` in `app.js` applies this before every capture,
so `videoTime` already has the runway built in — don't apply your own additional offset on top of
it when building a "jump to clip" feature server-side.
