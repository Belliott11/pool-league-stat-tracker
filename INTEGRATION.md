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
Beaten, Stops, Off Rating, Def Rating, Two-Way Score — is *computed* from `box_score_stats` +
`scoring_events` (+ the turnover/steal/foul event collections for TOV/STL/PF specifically), not
stored anywhere. See `shootingStats()`, `gameDefenseStats()`, `trueShootingPct()`,
`effectiveFgPct()`, `offensiveRating()`, `defensiveRating()`, and `twoWayScore()` in `app.js` for
the exact formulas if you want to replicate them as PocketBase views/queries instead of
recomputing client-side.

**Off Rating and Def Rating are a deliberate split of what used to be one function** (`gameScore()`
+ `defensiveImpact()`, now `offensiveRating()` + `defensiveRating()`) **— not just a rename, a real
formula change, so re-port both if you already ported the old pair.** The standard basketball Game
Score formula bakes in STL and BLK alongside the offensive stats, which meant this tool's old
"GmSc + Def Impact" combination credited a blocked shot *twice* whenever the blocker was also that
shot's tagged on-ball defender (the usual case): 0.7 from GmSc's BLK term, plus another 1.0 from
Def Impact's Stops term, for one defensive possession. `offensiveRating(s, sh)` is the old GmSc
formula minus its STL and BLK terms — offense only. `defensiveRating(s, def)` is where STL and BLK
live instead, next to the rest of the defensive numbers: `STL + 0.7×BLK_not_already_stopped +
Stops − Beaten − 0.4×Pts Allowed`, using the same per-shot defender tags as Pts Allowed/Beaten/
Stops above — no new stored data. `BLK_not_already_stopped` (see `blocksNotAlreadyStopped` in
`gameDefenseStats()`) is the count of this player's blocks on shots where they *weren't* also the
tagged on-ball defender — the block still needs to be genuinely uncovered by the Stops term to earn
its own 0.7 credit, otherwise it's zero, and the Stops term above already covers that possession at
full weight. Stops and Beaten are weighted symmetrically at 1.0 (a stop denies a possession the
same way STL is weighted at 1.0 too), Pts Allowed at 0.4 so a 3-point beat scores worse than a
2-point beat without double-penalizing the same possession the Beaten count already covers, and
Opp FG% deliberately isn't its own term since it's just Beaten ÷ (Beaten + Stops) — a separate term
would double-count that. Worth flagging if you're porting this: Def Rating is *not* the NBA's
Defensive Rating (points allowed per 100 possessions) — this tool doesn't track possessions at
all, so it reuses the same per-20-combined-points normalization as every other rate stat here
instead. Same name, different denominator; don't conflate the two if you ever add real possession
tracking. **A player never tagged as a defender in a game, with no steals or unstopped blocks, has
a Def Rating of exactly 0, not a penalty** — this matters because Ben's tagging policy is to only
tag a defender when it's genuinely clear from the video, so conservative tagging should never hurt
a Two-Way Score. If you replicate this server-side, make sure a "no tagged defensive possessions,
no steals, no unstopped blocks" player computes to 0, not null/undefined that then propagates as
NaN or gets treated as a bad defensive game. **Two-Way Score is Off Rating plus Def Rating.**

**Every counting stat on the Leaderboard page — not just PTS/20 and Off Rating/20 — is normalized
per 20 combined points scored in the game, not per game and not a season total**: PTS, OREB, DREB,
AST, STL, BLK, TOV, PF, Pts Allowed, Beaten, Stops, Def Rating, Off Rating, and Two-Way, plus the
FG/3PT/FT makes-attempts shown. See `gameTotalPoints()` and the `per20()` closure in
`computeLeaderboard()` in `app.js`. This matters uniformly, not just for points and Off Rating,
because games are capped at different targets (16 or 21), so a per-game average isn't directly
comparable across games; the combined final score is used as a stand-in for possessions/pace,
which this tool doesn't track directly. Keep this normalization if you replicate these stats
server-side, rather than switching to a naive per-game average — and apply it to every counting
stat, not a subset. A/TO and the shooting percentages are untouched by this, since they're
already ratios.

**Only a game with `scoringEvents.length > 0` AND equal team sizes counts toward a player's `gp`
(and therefore every rate above) at all.** A game that's just been rostered — or one that only
carries a historical `winner` imported with no shot-level detail, see the `winner` section above
— has nothing to normalize a rate from, so counting it would drag every rate toward 0 for a game
nobody's reviewed yet. `computeLeaderboard()` filters on this before computing anything else.

**Imbalanced games (3-on-2, or any other roster-size mismatch) are excluded from every computed
comparison by default, behind a reversible toggle — a data-quality fix, not a cosmetic one.**
`isBalancedGame(game)` (`app.js`, near `STAT_FIELDS`) is `game.teamA.length ===
game.teamB.length` — no new stored field, team size is just the roster array's own length.
`isQualifyingGame(game)` wraps the existing `scoringEvents.length > 0` check together with this:
`game.scoringEvents.length > 0 && (includeImbalancedGames || isBalancedGame(game))`.
`includeImbalancedGames` is a plain boolean persisted under
`localStorage["poolLeagueIncludeImbalancedGames"]`, default `false` — same toggle-with-a-default
pattern as `showAdvancedCols`. The reasoning: a 3-on-2 changes the game's own competitive shape
(spacing, individual defensive load, who's available to get open) enough that pooling its
per-player numbers into an otherwise-comparable "per 20 combined points" rate isn't a fair mix,
the same logic that already excludes an unreviewed game from `gp` — this is an extension of that
existing rule, not a new concept.

If you're porting this, the mechanical change was replacing every `g.scoringEvents.length > 0`
(or equivalent) check that gates a **season or league-wide comparison** with `isQualifyingGame(g)`
— `computeLeaderboard()`'s `gamesPlayed` filter, every Player Detail trend function's
`qualifyingGames` filter (Two-Way Trend, Teammate Synergy, Teammate Quality, both Matchup
Difficulty directions, Assisted By), `computeIndividualGamePerformances()` (Best & Worst Games),
`computePowerRankingVsPerformance()`, `computeCloseGameShooting()`, `computeLeagueTsOverTime()`,
`computeLeagueTsByZone()`, `computeSecondChanceConversions()`, `computeOutOfBoundsStats()`,
`computeAssistConnections()`, `computeGameWinningBuckets()` (via `gameWinningShot()` itself now
returning `null` for a non-qualifying game), `computeMatchupGrid()`, `computeWideOpenShooting()`,
`headToHeadAsScorer()`/`headToHeadAsDefender()`, and the League/Player/Defensive shot **heatmaps**
specifically (`renderLeagueHeatmap()`, `renderPlayerHeatmap()`, `renderPlayerDefensiveHeatmap()`
— these bucket into a zone FG%, a rate, unlike the plain dot-scatter Shot Chart below).

**Deliberately left untouched — these show history, not a comparison, so an imbalanced game stays
in them regardless of the toggle:** the individual Shot Chart (`renderPlayerShotChart()` — literal
make/miss dots at real locations, no rate computed), Player Detail's own Game Log (`games` in
`renderPlayerGameLog()`, unfiltered — every game this player was in, full stop), both Highlights &
Lowlights panels (`renderPlayerReel()`/`computeLeagueHighlights()` — a good clip is a good clip),
`computeFlaggedShotMismatches()` (a data-quality tool, needs to scan everything), and every CSV
export **except** the Leaderboard one (see below) — these are meant to be a raw, complete record,
same reasoning an unreviewed game already gets included in them today. `playerGameResult()` was
also left alone — it decides *how* to compute one game's own W/L (live score vs. historical
`winner`), not whether that game counts toward an aggregate; the aggregate-level exclusion already
happens upstream, in whichever `qualifyingGames`/`gamesPlayed` filter calls it.

The Games list shows a **⚖️ 2v3**-style badge (`app.js`, in `renderGames()`) on any game where
`isBalancedGame()` is false, so which games are affected is visible without cross-referencing
roster sizes by hand.

**Season boundaries reuse this exact same mechanism — a closed season archives games, it never
deletes them.** `state.currentSeasonStartedAt` (a date string, or `null` if no season's ever been
closed) and `state.seasonHistory` (`[{label, startedAt, endedAt}]`, oldest first) are the only two
new `state` fields; `loadState()` defaults both for anything imported before this existed.
`isCurrentSeasonGame(game)` is `!state.currentSeasonStartedAt || game.date >= state.currentSeasonStartedAt`,
folded into `isQualifyingGame()` alongside the balance check: `scoringEvents.length > 0 &&
(includeImbalancedGames || isBalancedGame(game)) && (includePastSeasons || isCurrentSeasonGame(game))`.
Because `isQualifyingGame()` already threads through every season/league-aggregate function from
the imbalanced-games work above, extending it here was the entire change needed to make every one
of those panels respect the season boundary and its own toggle — no new call sites to touch.
`includePastSeasons` (`localStorage["poolLeagueIncludePastSeasons"]`) is the toggle itself, same
default-off/persisted/button-relabels-itself pattern as `includeImbalancedGames`, with one
addition: disabled with an explanatory `title` whenever `state.currentSeasonStartedAt` is `null`,
since the toggle is a genuine no-op until a season's been closed at least once. **Two buttons
drive this one flag** — `togglePastSeasonsBtn` (Leaderboard) and `togglePastSeasonsBtnPlayer`
(Player Detail's own Past Seasons panel, added so combining a specific player's history doesn't
require switching to the Leaderboard first) — both listed in `PAST_SEASONS_TOGGLE_BTN_IDS` and
kept in sync by one shared `togglePastSeasonsInclusion()` handler: it flips `includePastSeasons`,
persists it, calls `updatePastSeasonsBtnLabel()` (which now loops both ids, relabeling/disabling
whichever exist), then re-renders `renderLeaderboard()` unconditionally and `renderPlayerDetail()`
only if `currentPlayerId` is set — so the view not currently on screen still ends up correct
without an extra render call showing up as a visible cost.

**Export → Data Management → Start New Season** (`app.js`, near `resetDataBtn`) is the only thing
that writes to these two fields: it `prompt()`s for a label, pushes `{label, startedAt:
state.currentSeasonStartedAt, endedAt: today}` onto `seasonHistory`, and sets
`currentSeasonStartedAt = today` — that's the entire "close a season" operation as far as game/stat
data goes. It does **not** touch `state.games`, `state.players`, `state.playerPhysicalOverrides`
(a player's height/build/role edits from the Players tab), or any player's stats; it only
also deletes every locally-stored video blob (`getAllStoredVideoIds()` → `deleteVideoFile()` for
each) and clears `state.masterVideos`, since those are large and re-watching last season's footage
isn't the point of keeping the stats — a past game's `masterVideoId`/local video reference just
goes dangling afterward, the same already-handled case **Export → Broken Session Video Links**
exists for. `resetDataBtn` (the actual full wipe) additionally resets `seasonHistory: []` and
`currentSeasonStartedAt: null`, so a truly empty tracker doesn't retain stale season boundaries.

**Player Detail's Past Seasons panel is deliberately not built on the toggle/`isQualifyingGame()`
path at all.** `computeSeasonHistoryForPlayer(playerId)` filters `state.games` itself, once per
entry in `seasonHistory` (`game.date` between that entry's `startedAt`/`endedAt`, real shots
logged, balance-toggle-respecting) and runs `computeRateSummaryForGames()` on each resulting
subset — the same shared helper Two-Way Trend/Teammate Synergy/Teammate Quality already use, just
scoped to a season's date range instead of a game subset. This has to stay a separate code path
from `isQualifyingGame()` on purpose: the toggle blends every archived season *into* the current
one for one combined number, while this panel's whole job is showing each closed season *on its
own row*, side by side, regardless of whatever the toggle happens to be set to at the moment.
Nothing here is a frozen snapshot — every number is recomputed from the still-fully-intact game
records on every render, so if a stat's formula changes later (as several already have this
season), a past season's own numbers update right along with the current one's, exactly the same
"recompute, don't trust a stored copy" rule this entire tool already runs on everywhere else.

The Leaderboard CSV export is a separate code path (calls `computeLeaderboard()` directly rather
than iterating `scoring_events` itself, unlike the other CSVs) and still exports raw season totals
plus `games_played` rather than per-20 rates for every column — it only computes PTS/20, Off
Rating/20, Def Rating/20, and Two-Way/20 directly, same as before. Because it shares
`computeLeaderboard()` with the on-screen table, it also shares that table's `isQualifyingGame()`
filter — it's the one CSV that respects `includeImbalancedGames`, unlike every other export
above. If you're pulling from the CSV (or replicating a season-totals collection) rather than
scraping the rendered page, you have the totals; apply the same per-20 normalization yourself for
whatever rate you want to show, same as the dashboard's own UI layer does.

**Shot% (Leaderboard) is also purely computed, nothing stored — and is deliberately not a per-20
rate either, same family as A/TO and the shooting percentages above.** It's a season-long share:
this player's own field goal attempts divided by their *team's* total field goal attempts, summed
across the games they played (`teamFgaTotal` in `computeLeaderboard()`, `app.js`) — not the
league's shots, their team's, since "who's actually taking the shots on a given night" is a
question about the handful of people sharing the floor with them, not the whole roster. The
denominator is built per game from whichever side (`teamA`/`teamB`) the player was actually on
that game, summing `shootingStats(game, id).fga` for every player on that side (the player
themselves included) — this needs the full roster per game, not just this one player's own
numbers, which is why it's computed inline in `computeLeaderboard()`'s own per-game loop rather
than reusing a value already being tracked elsewhere. Free throws are deliberately excluded from
both sides of the ratio (`fga` only ever counts `points === 2 || 3`, matching `shootingStats()`
everywhere else in this tool) — a player who draws a lot of fouls but rarely shoots from the field
shouldn't show an inflated Shot% because of it.

**AST% (Leaderboard) is the same pattern applied to assists, computed inline the same way** —
`teamAstTotal` in `computeLeaderboard()`, built per game by summing `g.stats.find(st =>
st.playerId === id).ast` for every player on the player's own side that game (themselves
included), then `astPct: pct(totals.ast, teamAstTotal)`. Same season-long share, same
team-scoped denominator, same reasoning as Shot% above: it's about what fraction of *this team's*
playmaking on a given night ran through this player, not a share of the league's assists.

**OREB%/DREB% (Leaderboard) are a different case from Shot%/AST% — the real rebound-percentage
formula, not the team-share pattern, made possible by a Poolean-specific shortcut.** The actual
Total Rebound % / OREB% / DREB% formulas measure a player's rebounds against every rebound that
was actually *available*, which for offense means both teams' outcomes on that team's own misses
(their team's OREB plus the opponent's DREB), and for defense the mirror (their team's DREB plus
the opponent's OREB on the opponent's misses) — a rebound is contested between both teams on the
floor, unlike a shot attempt or an assist, which only one side can ever produce. The real-world
version of this stat normally has to scale by minutes played, to restrict "available" down to
possessions where the player was actually on the floor — this tool doesn't track minutes at all,
but Poolean has no substitutions, so every rostered player is on the floor for the entire game,
and the minutes term real implementations need just drops out algebraically. Computed inline in
`computeLeaderboard()` as `orebPoolTotal`/`drebPoolTotal`: for each game, sum `oreb`/`dreb` across
the player's own roster (`teamOreb`/`teamDreb`) and the opposing roster (`oppOreb`/`oppDreb`) from
`g.stats`, then `orebPoolTotal += teamOreb + oppDreb` and `drebPoolTotal += teamDreb + oppOreb`;
`orebPct: pct(totals.oreb, orebPoolTotal)`, `drebPct: pct(totals.dreb, drebPoolTotal)`. If you
port this, don't reuse `teamFgaTotal`/`teamAstTotal`'s pattern (own team only) — this one needs
both rosters' rebound totals for every game the player played, not just their own team's.

**TRB% (Leaderboard) is just OREB%'s and DREB%'s two pools added together — no new
accumulator.** `trebPct: pct(totals.oreb + totals.dreb, orebPoolTotal + drebPoolTotal)`. This
works because `orebPoolTotal + drebPoolTotal` already equals total rebounds across both teams and
both categories for every game the player played (each missed shot contributes to exactly one of
the two pools), which is exactly what the real TRB% formula's denominator is.

**TOV% (Leaderboard) is a different shape from every other new "%" column — a share of this
player's own plays, not a share of any team or pool total.** `turnoverPct(tov, fga, fta)` (`app.js`,
near `trueShootingPct()`) is `TOV / (FGA + 0.44×FTA + TOV)` — the standard formula, reusing the
same 0.44 FTA-to-possession scaling `trueShootingPct()` already uses, so a free throw trip counts
as a fraction of a "play" the same way in both places. Unlike Shot%/AST%/OREB%/DREB%, this needs
no team or opponent roster data at all — it's computed directly off `computeLeaderboard()`'s own
`totals.tov`/`shooting.fga`/`shooting.fta` for that player, same signature style as
`trueShootingPct(pts, fga, fta)` so it also works per-game if you ever want it on the Game Stats
table, not just season-wide on the Leaderboard.

**All six "%" columns are hidden by default, client-side only — nothing to port here unless you
want the same UX.** Each is marked `advanced: true` on its `LEADERBOARD_COLUMNS` entry;
`visibleLeaderboardColumns()` filters `LEADERBOARD_COLUMNS` down to `!c.advanced ||
showAdvancedCols` before either the header or body render loop touches it (`renderLeaderboardHeader()`
and `renderLeaderboard()` in `app.js` both call this instead of using `LEADERBOARD_COLUMNS`
directly now — if you add a new column, decide whether it belongs in that filtered set the same
way). `showAdvancedCols` is a plain boolean persisted under `localStorage["poolLeagueShowAdvancedCols"]`,
same pattern as the theme toggle. Toggling it off resets `leaderboardSort` to the default (`pts`
desc) if the table happened to be sorted by a column that just got hidden, so nothing gets stuck
sorted by an uninteractable column. The Leaderboard CSV export (`exportLeaderboardCsvBtn`) is a
separate code path that always includes all six regardless of `showAdvancedCols` — the toggle is
purely a display concern for the on-screen table, not a data-scoping one.

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
per-player object) specifically for MVP, Def Rating/20 rank for DPOY, Game-Winning Buckets for
Clutch (see below), the Last 5 trend for Most Improved (`last5TwoWayPer20` vs. `twoWayPer20`,
same mechanism as the Leaderboard's own Last 5 column but Two-Way instead of Off Rating here), or the
average Two-Way/20 lift a "Best Teammate" winner gives their actual teammates, reusing
`computeTeammateSynergy()` from the section above — same "nothing stored, always current"
pattern as the rest of this page. If you add a new season's awards, that means editing
`AWARD_RESULTS` by hand (or building a real `award_results` collection and reading from it) —
there's no mechanism here that pulls it from anywhere automatically. This is one of three
hardcoded season-snapshot tables (`AWARD_RESULTS`, `PARTY_RANKINGS`, `PLAYER_REPUTATION_DATA`)
that Ben's own **Export → Data Management → Start New Season** button deliberately can't touch,
since they're baked into this source file, not runtime `state` — see README.md "Starting a new
season" for the full checklist. If you build a real backend collection for any of these instead,
that's the natural place to make the season transition actually automatic, which a static
hardcoded array never can be. Winner slugs are matched
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
for a stat surfaced on its own dedicated panel.

**Worth knowing about the metric itself, confirmed against real production data**: in a
race-to-target format with no clock, the last basket of *every* decided game is structurally
guaranteed to belong to the winning team — the game ends the instant someone reaches the target,
so there's no "last shot before the buzzer" ambiguity the way clock-based basketball has. That
means GWB isn't tracking rare, buzzer-beater moments; it's a "who tends to be the one closing
games out" tally that grows by exactly one per fully-timestamped decided game, distributed across
whoever happens to hit the target-reaching shot. Also confirmed in production: the timestamp gate
turns out not to exclude much in practice — a full ten-game, 365-shot review with disciplined
timestamping had all ten games qualify. Both are worth keeping in mind if you build UI copy around
this number — it's a real signal, just not the "rare and memorable" one the name might suggest,
and (as of this session) it's no longer the Clutch award's tracked-stat comparison — see the
Close-Game Shooting entry below for what replaced it and why.

**Close-Game Shooting is also purely computed, nothing stored — and is now the actual `statKey`
behind the Clutch award, not GWB.** `computeCloseGameShooting()` (`app.js`) filters to games where
`Math.abs(teamScore(teamA) - teamScore(teamB)) <= CLUTCH_MARGIN_THRESHOLD` (5, a single adjustable
constant, currently a starting guess with no real season margin data behind it), **including tied
games** — deliberately different from `gameWinningShot()`'s own filter, which excludes ties
outright since a tie has no winning shot to credit. There is no winning-shot concept here at all;
this is plain `trueShootingPct()` pooled across every attempt a player took in a qualifying game,
regardless of who won. This panel originally shipped as a companion sitting *alongside* GWB,
deliberately not wired into `AWARD_RESULTS`'s Clutch entry, out of respect for an earlier
maintainer decision to leave the existing Clutch/GWB pairing as-is — that decision was
subsequently reversed by the maintainer later in the same session ("make close game shooting the
stat for clutch player"), so Clutch's `statKey` is now `"closeGameTs"` (`computeAwardStandings()`
sorts `computeCloseGameShooting()` by `.ts` descending), with a matching `AWARD_NOT_FOUND_TEXT`
entry. GWB itself is untouched and still rendered as its own panel — only the award linkage moved.
If your backend keeps its own copy of `AWARD_RESULTS`/the statKey wiring, this is the one field to
re-sync, not a schema or computation change.

**Best & Worst Individual Games on the Leaderboard is also purely computed, nothing stored.**
`computeIndividualGamePerformances()` (`app.js`) is the one panel on this page that deliberately
does *not* normalize to a per-20 rate or a season total — every other panel does that specifically
so players are comparable across different sample sizes, which is exactly what averages away a
single game's own story. For every player on either roster in every game with
`scoring_events.length > 0`, it computes that one game's own `twoWayScore(stats, shooting,
gameDefenseStats(game, playerId))` — the same function `computeLeaderboard()` already uses, just
evaluated for one game's raw totals instead of summed/rated across a season.
`renderIndividualGamePerformances()` sorts all of those rows once, then takes the top and bottom
`n = min(10, floor(rows.length / 2))` — the floor-by-2 cap exists specifically so a thin season
(few enough games that the "worst 10" and "best 10" would overlap) doesn't show the same handful
of games in both lists, just reversed, which would read as a bug rather than a real result.

**Highlights & Lowlights (League) on the Leaderboard is also purely computed, nothing stored.**
`computeLeagueHighlights()` (`app.js`) is the exact same data Player Detail's own Highlights &
Lowlights table reads (`game.plays`, one row per tagged clip: `playerId`, `type`
("highlight"/"lowlight"), `start`, `end`, `note`) — just pooled across every player instead of
filtered to one, with a `player` object attached to each clip and a `date`/`gameId` carried
through for the "Go to game" button. No new field, no new query shape versus what
`renderPlayerReel()` already does; this just drops the `play.playerId === playerId` filter and
adds a Player column.

**Combine Clips Into One Video (Stat Entry → Reel) is the one feature in this whole document that
isn't "purely computed, nothing stored" — it's live client-side video processing, not analysis,
and it's browser-API-dependent in a way nothing else here is, so read this one before deciding
whether/how to port it.** `exportReelVideo()` (`app.js`) plays every clip in `game.plays`
(filtered to `end > start`, sorted by `start` ascending — chronological regardless of the Reel
table's current UI sort) back-to-back through the already-loaded `<video>` element, capturing the
live playback with `HTMLMediaElement.captureStream()` piped into a `MediaRecorder`. No ffmpeg, no
server round-trip, no new dependency — but also no fast/batch trim-and-concat: it runs in wall-clock
real time (recording a clip takes exactly as long as that clip's own duration), and output is
`.webm`, `MediaRecorder`'s one broadly-supported container — there's no in-browser path to `.mp4`
without taking on an ffmpeg.wasm-sized dependency, which this tool deliberately doesn't carry.

If you build an equivalent against Poolean's own video infrastructure, the two things worth
replicating exactly, both hardened after a real bug found in testing:
- **`MediaRecorder.pause()`/`.resume()` around each clip, not `.start()`/`.stop()` per clip.**
  Recording only actually captures during the two calls surrounding real playback; the recorder
  starts paused (`recorder.start(); recorder.pause();`) so the seek/load time *between* clips
  never ends up in the output, and pause/resume keeps it one continuous session, so the result is
  one seamless file rather than several to stitch together afterward.
- **Every awaited step is raced against a cancellation signal, not just checked between steps.**
  The first version only checked a plain `cancelled` boolean *between* awaits — which meant a
  hung `video.play()` (blocked autoplay policy, a stalled source, whatever the cause) couldn't be
  interrupted by the Cancel button at all, since the code was stuck *inside* that one await with
  no boolean check ever getting a chance to run. Confirmed in testing: a deliberately-hung mock
  `play()` left the old version stuck with no way out short of reloading the page. The fix races
  every step (seeking, playing, waiting for a clip to end) against a `cancelPromise` that a Cancel
  click resolves, plus an 8-second timeout specifically on `video.play()` so an export can't hang
  forever even if nobody clicks Cancel. If you build your own version of this, whatever you use in
  place of a boolean cancelled flag needs to be able to interrupt an in-flight await, not just get
  read after it returns.

**Combine All Clips Into One Video (Leaderboard → Highlights & Lowlights (League)) extends the
same approach across every game, not just the one currently open — one real architectural
difference worth knowing if you port this one too.** `exportLeagueVideo()` (`app.js`) reuses
`pickRecorderMimeType()`/`waitForSeek()`/`waitUntilTime()`/`raceCancel()` unchanged from the
per-game version above — the per-clip mechanics don't change — but records from its own dedicated
`<video>` element (`#leagueExportVideo`, a small visible preview player, not `currentVideoEl`,
since there may be no game open at all) whose `src` gets swapped between games rather than
creating a new element/stream per game. That's deliberate, not incidental: `captureStream()`
binds to one element, and swapping that element's `src` keeps the same `MediaStream` (and
therefore the same `MediaRecorder` session) valid across the whole export, so `pause()`/`resume()`
around each game's load — same mechanism as around each clip within a game — is what keeps this
one continuous file instead of one per game to stitch together.

Two things specific to spanning multiple games, not present in the per-game version:
- **Video source resolution has its own cache and fetch path
  (`getGameVideoSrcForExport()`/`leagueExportVideoSrcCache`), deliberately not reusing
  `loadStoredVideo()`/`loadStoredMasterVideo()`.** Those two assume there's exactly one "currently
  open" game (they gate on `gameId === currentGameId` and call `renderStatEntry()` on success) —
  correct for the Stat Entry page's own UI, wrong for a batch export touching many games most of
  which aren't open. The resolution order matches `renderVideoPanel()`'s own priority: a stored
  master/session video first (`getVideoFile(game.masterVideoId)`), then a stored per-game file
  (`getVideoFile(game.id)`), then `game.videoUrl` *only* if it's a direct video link and not a
  YouTube URL — a YouTube embed or generic iframe link resolves to `null`, and that game's clips
  are counted as skipped rather than attempted.
- **Every game's video source is resolved up front, before any recording starts, not lazily as
  each game comes up in the loop.** This means "how many clips/games will be skipped" is known
  (and reported in the final summary) before spending any real recording time on the games that
  *do* have video, and a session video shared by several games only gets fetched from IndexedDB
  once no matter how many of that game's clips end up in the queue, since the fetch is
  cache-keyed on `masterVideoId || game.id`, not on the clip.

**Player Detail's Shot Chart is also purely computed, nothing stored — the ungrouped
counterpart to the heatmap just below it.** `renderPlayerShotChart()` (`app.js`) plots every one
of a player's own field goals with a non-null `shot_x`/`shot_y` at its literal coordinates
(reusing the same `shotChartVbX`/`shotChartVbY` transform as everything else), one dot per shot,
green for a make and red for a miss, rather than bucketing into the heatmap's 5×6 zones. Purely
a presentation choice over the same underlying data — no new field, no new computation beyond
"is this shot's location marked," and the hoop marker draws before the dots for the same reason
it draws before the heatmap's cells: so it never sits on top of one.

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

**Player Detail's Defensive Heatmap is also purely computed, nothing stored.** Same
`computeHeatmapCells()` grid as the offensive heatmaps, but the input shot list is filtered to
every field goal where `defenders` includes this specific player (`renderPlayerDefensiveHeatmap()`
in `app.js`), same fan-out rule as `gameDefenseStats()`/`headToHeadAsDefender()` — a double-teamed
shot counts toward every tagged defender, not split between them. **Deliberately per-player only,
not a league-wide aggregate** — a league-wide version was built and then removed during this
session specifically because a single aggregate collapses the exact signal this panel exists to
show ("does *this* player's own Opp FG% hold up at every distance"). The one thing that actually
changes from the offensive heatmaps, not just the filter: **cell color is inverted**
(`defensiveHeatmapCellColor()` in `app.js`, hue `= (1 - fgFrac) * 120` instead of `fgFrac * 120`).
A low FG% is good defense, so reusing the offensive heatmap's red-low/green-high mapping unchanged
would show good defense as red — get this backwards and the whole panel reads as the opposite of
what it means. `renderHeatmapSvg()`/`renderHeatmapInto()` both take an optional `colorFn` param
(default `heatmapCellColor`) specifically so this variant can share every other line of heatmap
code and only swap the color function.

**The Head-to-Head Matchup Grid on the Leaderboard is also purely computed, nothing stored.** It's
the league-wide pivot of the exact same query the per-player Head-to-Head tables on Player Detail
already run (`headToHeadAsScorer()` / `headToHeadAsDefender()` in `app.js`) — `computeMatchupGrid()`
just runs that counting logic for every scorer against every defender in one pass instead of one
player at a time, keyed on `` `${scorerId}|${defenderId}` ``. Same counting rule as those two
existing functions, worth replicating exactly if you port this: a scoring event with multiple
`defenders` (a double-team) increments **every** tagged defender's cell against that scorer, not
just one — this is not filtered to `points === 2 || 3` either, matching those functions' existing
(not-FG-only) behavior. Cell color reuses the same red-to-green FG% hue as the heatmap, with an
opacity ramp identical in spirit to `heatmapCellColor()` (more attempts = more opaque = more
confident), so a 1-for-1 cell visually reads as far less certain than a well-sampled one even
though both would show 100%. Rows and columns are sorted independently, each by that scorer's or
defender's own total tagged attempts — the two orderings are unrelated to each other.

**Wide-Open Shooting on the Leaderboard is also purely computed, nothing stored.** The inverse
filter from the Matchup Grid above: `computeWideOpenShooting()` (`app.js`) only counts a field
goal attempt (`points === 2 || 3`, same restriction as Close-Game Shooting and every other
efficiency panel) toward a player's numbers when `defenders` is empty or absent, i.e. nobody
tagged a defender on that specific shot. **Free throws are excluded outright, not merely
untouched by the filter** — an FT is uncontested by rule, so counting it here would silently
inflate every player's wide-open share and TS% with a shot type that was never actually a read on
defensive pressure. `share` is `wideOpenFga / totalFga` for that player (their own denominator,
not the league's), printed alongside TS% specifically so a small-sample TS% (2 wide-open looks)
doesn't read the same as a well-sampled one (20).

**The Two-Way Quadrant chart on the Leaderboard is also purely computed, nothing stored.**
`computeQuadrantData()` (`app.js`) is a thin wrapper over `computeLeaderboard()` — one point per
player with `gp > 0`, x = `offRatingPer20`, y = `defensiveRating(rate, rateDefense)`. No new fields, no
new computation; it's the existing Two-Way Score inputs plotted separately instead of pre-summed.
`renderQuadrantChart()` scales both axes symmetrically around zero (`maxAbs * 1.15` in each
direction) rather than to the data's actual min/max, so the zero-crossing quadrant lines always
land at the plot's visual center — worth keeping if you reimplement this, since scaling to min/max
instead would put the crossing point wherever this particular roster's data happens to center,
not at the meaningful zero boundary both stats already use on their own. Each dot's `fill` is set
inline via `playerChartColor(index)` (`app.js`), an 8-color Okabe-Ito colorblind-safe palette
cycling by array index — replacing an earlier version where every dot shared the single
`var(--accent)` teal, which on a real roster was indistinguishable dot-to-dot beyond the small
text labels. The same helper drives Volume vs. Efficiency's dots below. Legibility note that
applies to every SVG chart on this page, not just this one: axis lines were originally styled with
`var(--border)` (a deliberately low-contrast token meant for subtle dividers) and axis/label text
at 6.5-8px — both read as "barely there" once actually tested. Every `*-axis` class now uses
`var(--muted)` (or `var(--text)` for the more important labels) at a heavier stroke-width, and
label font-sizes were bumped to 9-11px; the red-to-green hue scales used elsewhere (heatmaps,
Matchup Grid, Teammate Lift Matrix, TS% by Shot Distance) had their saturation raised from 70% to
85% for the same reason — a continuous hue sweep's yellow/olive midpoint is where the eye is worst
at telling two values apart, and the extra saturation genuinely helps.

**Volume vs. Efficiency on the Leaderboard is also purely computed, nothing stored.** A second
scatter, deliberately separate from the Two-Way Quadrant above rather than a third axis bolted
onto it — `computeVolumeEfficiencyData()` (`app.js`) plots x = `rateShooting.fga` (attempts per 20
combined points — the same volume rate the main table's own FGA column already shows), y =
`trueShootingPct(totals.pts, shooting.fga, shooting.fta)` (season TS%, the identical calculation
the main table's TS% column uses, not a new formula). Offense only, no defensive dimension at all.
Same overflow risk as TS% by Shot Distance above and the same fix: TS% isn't capped at 100% for a
small enough sample, so `renderVolumeEfficiencyChart()` scales its y-axis to `Math.max(100,
...values) * 1.08` rather than a fixed range — carry that forward if you port this chart, for the
same reason.

**Shot Distance is now a single merged panel, not two.** It used to be split into "Shot Distance"
(FG% per zone) and "Shot Selection" (share of attempts per zone) — both per-player, both the exact
same four zones and same underlying `computeLeaderboard()` shooting splits, just two different
numbers. They were combined mid-session once that redundancy was pointed out: `SHOT_ZONES` (the
zone/color/accessor definitions), `SHOT_ZONE_COLUMNS` (built from it, `Player` + one column per
zone + `Attempts`, all sortable via `renderSortableHeader()`), and `renderShotZonePanel()` in
`app.js`. Each zone `<td>` carries both numbers now (FG% split as the sortable value, share of
attempts as a muted sub-label underneath) — reusing the old Shot Selection stacked-bar markup as
a final non-sortable **Mix** column, appended to the header row by hand after
`renderSortableHeader()` builds the real sortable columns (a stacked bar has no single number to
sort by, so it isn't one of `SHOT_ZONE_COLUMNS`). If you already ported the two separate panels,
this is a straightforward one-table consolidation, not a data or formula change — every number in
the merged table is identical to what the two old panels showed.

**Five more tables became sortable via `renderSortableHeader()`, pure UI, no computation
changed.** The per-game **Game Stats** table (`GAME_STATS_COLUMNS`/`renderGameStatsTable()`) and
Player Detail's **Game Log** (`PLAYER_GAME_LOG_COLUMNS`/`renderPlayerGameLog()`) both went from a
static `<thead>` to the same sortable-column pattern the Leaderboard and Shot Distance already
use — rows are built into a plain array first (`{player, team, s, def, sh, offRtg, twoWay}` for Game
Stats; `{game, s, sh, def, result, offRtg, twoWay}` for Game Log), sorted once by whichever column's
`accessor` is active, then rendered. Head-to-Head — As Scorer/As Defender
(`H2H_SCORER_COLUMNS`/`H2H_DEFENDER_COLUMNS`) and Teammate Synergy
(`TEAMMATE_SYNERGY_COLUMNS`) got the same treatment on top of their existing compute functions —
no change to `headToHeadAsScorer()`/`headToHeadAsDefender()`/`computeTeammateSynergy()`
themselves, just a sort step inserted between computing the rows and rendering them. Two small
things worth replicating if you build equivalent sortable tables: Teammate Synergy's With/Without
columns return `null` (not `0`) from their accessor when that side has zero games, since
`compareForSort()` already sorts `null` last regardless of direction — a real 0 would sort as a
legitimate (and misleadingly bad) value instead. And Game Stats' Player column keeps its
`sticky-col` CSS class by adding it back onto the header cell after `renderSortableHeader()`
rebuilds the row, since the shared helper doesn't know about that class.

**League TS% Over Time on the Leaderboard is also purely computed, nothing stored.** Unlike every
other panel that reuses `computeLeaderboard()`'s per-player rows, `computeLeagueTsOverTime()`
walks `scoring_events` directly and pools `pts`/`fga`/`fta` across *every* player in a game, then
groups by `date` (summing across every game on that date before computing one `trueShootingPct()`
per date) — because this is deliberately a single league-wide line, not a per-player stat, meant
for eyeballing efficiency drift over a season. A date with no attempts (or where `fga`/`fta` net to
a zero denominator) is dropped from the series rather than plotted as a 0%.

**TS% by Shot Distance on the Leaderboard is also purely computed, nothing stored.** A 4-bar
version of the same Close/Midrange/Line/Deep split as the Shot Distance table and Shot Selection
chart above it — `computeLeagueTsByZone()` (`app.js`) buckets every field goal with a marked
`shot_x`/`shot_y` by `shotBand()`, then runs `trueShootingPct(pts, fga, 0)` per zone. The `0` for
`fta` is deliberate, not a bug: free throws have no shot location, so they're excluded from every
zone's denominator here, unlike the over-time TS% line above (which does include them, pooled
league-wide rather than per-zone). One thing worth knowing if you port the visualization, not just
the number: **zone TS% is not capped at 100%.** A small, all-made three-point sample for a zone
clears it trivially (`pts / (2 × fga)` with `pts = 3`, `fga = 1` is 150%) — real season volume
makes this rare but not impossible early in a season or for a thin zone, so a bar chart needs a
dynamic y-axis ceiling (`Math.max(100, ...values) * some headroom factor`, not a fixed 0–100
scale) or a value like this renders as a bar clipped off the top of the chart. This was caught in
testing against exactly that case, not a hypothetical.

**Assist Connections on the Leaderboard, and Teammate Synergy on Player Detail, are also purely
computed, nothing stored.** Deliberately *not* a win/loss duo table — the real site already has
that.

**The Teammate Lift Matrix on the Leaderboard is also purely computed, nothing stored.** It's the
grid version of Average Teammate Lift, the Best Teammate award's own stat comparison (see the
`teammateLift` block in `computeAwardStandings()` above) — same underlying With/Without pairwise
comparison, laid out as a full row-by-column grid instead of one averaged number per player.
`computeTeammateLiftMatrix()` (`app.js`) calls `computeTeammateSynergy()` once per player (not
once per pair — `computeAwardStandings()`'s own `teammateLift` block actually does call it once
per *pair*, an O(n²) pattern that works fine at this roster's size but isn't the one to copy if
you're rebuilding this from scratch) and looks the rest up from that cached result. The critical
thing to get right if you port this: **the grid is not symmetric.** Cell (row A, col B) is "with A
on the team, how did B's own Two-Way/20 change" — a fact about B's games. Cell (row B, col A) is
the mirror question about A's games, computed from a completely different set of games (A's
games, not B's) and can come out very different in practice, not just in principle — this was
directly observed in testing, not a theoretical caveat (one direction came out near-zero while the
reverse direction was over 14 points on the exact same synthetic pairing). Don't average the two
directions together or treat a diagonal-symmetric layout as a bug to fix.

`computeAssistConnections()` walks every `scoring_events` row with a non-null `assist` on a make,
and tallies `(assister, scorer)` pairs — directional, since Alice assisting Bob is a different
fact from Bob assisting Alice. This is a straight readout of data already in `scoring_events`,
nothing new to store.

`computeTeammateSynergy(playerId)` is per-player, not league-wide: for each teammate this player
has shared `teamA`/`teamB` with (in a game with `scoring_events.length > 0`), it splits that
player's *own* games into "with" that teammate on their side vs. "without" (teammate on the other
team, or not in that game), and compares Off Rating/20 and Two-Way/20 across the split using the same
per-20 math as `computeLeaderboard()` — see `computeRateSummaryForGames()` in `app.js`. This is
the closer thing to a real "synergy" signal (does this player's own output change with a given
teammate on the floor) than a duo's shared win/loss record ever was, but it needs a real sample on
both sides of the split to mean anything — a teammate this player has *always* played with has no
"without" games to compare against, which the UI shows as "—" rather than a misleading 0.0.

**Teammate Quality, Assisted By, and Defensive Matchup Difficulty on Player Detail are also purely
computed, nothing stored.** Built to answer a concrete question rather than round out the page:
does a player's own production actually lean on the players around them — better teammates
creating mismatches and feeding easy shots, or a lighter defensive assignment because someone
else draws the other team's best player? All three use the same "quality" yardstick —
`offRatingPer20` from `computeLeaderboard()`, not `twoWayPer20` — deliberately, since the
mechanism each one is testing (offensive gravity: drawing attention, creating mismatches, setting
up shots) is about offensive skill specifically, not two-way value.

`computeTeammateQualityTrend(playerId)` (`app.js`, near `renderTwoWayTrendChart()`) walks this
player's qualifying games, and for each one averages `offRatingPer20` across every *other* player
on their own roster that game (skipping anyone with `gp === 0`, i.e. no season number to average
in), producing one point per game. The season average is **pooled across every (game, teammate)
appearance, not a mean of the per-game averages** — `sumQuality / countAppearances` across the
whole season, same "sum totals once, divide once" preference every per-20 rate on this tool
already follows, rather than averaging pre-averaged per-game numbers (the two aren't
mathematically identical when roster size varies game to game). No leave-one-out correction: a
teammate's own `offRatingPer20` still includes every game they played, including ones where this
player benefited from them too — a known simplification, not an oversight.

`computeDefensiveMatchupDifficultyTrend(playerId)` is the mirror on defense: for each qualifying
game, it filters `scoring_events` to ones where this player is in `defenderIds`, and averages the
*scorer's* `offRatingPer20` across those shots — weighted per shot, not deduplicated per opponent,
matching how Stops/Beaten/Pts Allowed already treat a double-teamed or repeatedly-guarded shot as
one event each. Same pooled-season-average approach as Teammate Quality above.

`computeOffensiveMatchupDifficultyTrend(playerId)` is the mirror from the *scorer's* side — how
tough have the defenders guarding THIS player's shots been. For each qualifying game, it filters
`scoring_events` to ones where this player is the `scorer` and `points` is 2 or 3, then averages
`defensiveRating(rate, rateDefense)` (not `offRatingPer20` — the relevant quality here is how good
those defenders have been *defensively*) across every id in each shot's `defenderIds`, a
double-teamed shot contributing once per tagged defender same as everywhere else. An untagged
(wide-open) shot contributes nothing to either the point or the season average — there's no
defender to rate, matching how Wide-Open Shooting already excludes those attempts from a
"contested" read. Easy mix-up if you're porting this: Off Matchup Difficulty reads the *defender's*
Def Rating, Def Matchup Difficulty reads the *scorer's* Off Rating — the two aren't the same field
read from two directions, they're genuinely different stats on the opponent.

`computeAssistedByBreakdown(playerId)` walks every `scoring_events` row where this player is the
scorer, `made !== false`, and `points` is 2 or 3 (free throws excluded — they don't carry an
assist by rule, same convention `shootingStats()` uses everywhere else), tallies makes with vs.
without an `assist`, and groups the assisted ones by assister with that assister's own
`offRatingPer20` attached. `avgAssisterQuality` is the assist-count-weighted average of those
qualities — players who set this player up more often count for more, same idea as a weighted
mean anywhere else.

All four panels share `renderTrendLineChart(containerId, points, seasonAvg, unitLabel)` — a
generalized version of the hand-written SVG line chart `renderTwoWayTrendChart()` already used
(same per-game-points-plus-dashed-season-average shape, parameterized instead of hardwired to
Two-Way/20). `renderTwoWayTrendChart()` itself was left untouched rather than rewritten on top of
the new shared function, so the existing chart wasn't put at risk for a cosmetic dedupe.

**Teammate Context on the Leaderboard is the same four panels' season averages, league-wide,
also purely computed.** `computeTeammateContext()` (`app.js`, near `renderTeammateLiftMatrix()`)
maps every player with `gp > 0` from `computeLeaderboard()` and, per player, calls
`computeTeammateQualityTrend()`, `computeOffensiveMatchupDifficultyTrend()`,
`computeDefensiveMatchupDifficultyTrend()`, and `computeAssistedByBreakdown()` — the exact same
functions Player Detail uses, just reading off `.seasonAvg`/`.assistedPct`/`.avgAssisterQuality`
instead of rendering the full trend or breakdown. No separate computation to keep in sync with
Player Detail; if you change one of those functions, both surfaces pick it up. This does mean
`computeLeaderboard()` runs multiple times per player inside the loop (each helper calls it
independently) — fine at this roster's size, not the pattern to copy if you're optimizing a much
larger one. Sortable via the same `TEAMMATE_CONTEXT_COLUMNS`/`renderSortableHeader()` pattern as
everywhere else.

**Bug fix, while touching this part of the page:** `index.html`'s Player Detail `</section>` was
misplaced one panel too early, closing `#tab-player` right after Teammate Synergy — which left the
Highlights & Lowlights panel outside *every* tab section. Since `.tab-panel { display: none }`
only applies to elements inside a tab section, that panel was rendering unconditionally on every
tab, not just Player Detail, stacked below whichever tab was actually active. If your own build
scraped this page's structure or independently noticed a stray/duplicate Highlights table showing
up somewhere it shouldn't, this was the cause — fixed by moving `</section>` to after the media
panel, where it always should have been.

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
per-20 Off Rating math as the season column, just scoped to a player's 5 most recent games with
`scoring_events.length > 0` (by `date`, not insertion order — sort descending and slice first),
via `computeRateSummaryForGames()` reused from Teammate Synergy above. The ▲/▼/– trend arrow
compares that windowed Off Rating/20 against the player's season Off Rating/20, with anything
inside ±0.5 treated as flat (`●`, not a dash — a dash next to a number reads as a minus sign)
rather than a real trend. Not included in the Leaderboard CSV export, matching that export's
existing scope (raw season totals plus PTS/Off Rating/Def Rating/Two-Way per 20 — see above), not
a mirror of every UI column.

**Player Detail's Two-Way Trend chart is also purely computed, nothing stored.** The graphical
version of the "Last 5" text above: `computeTwoWayTrend()` (`app.js`) sorts this player's
qualifying games chronologically and runs `computeRateSummaryForGames(playerId, [game])` on each
one individually — a one-game array, so it's the same per-20 math as everywhere else, just
normalized against that single game's own combined score rather than the season's. The season
average (drawn as a dashed reference line, `computeRateSummaryForGames()` again over every
qualifying game) is the same number the Leaderboard's own season Two-Way/20 column shows for this
player. No separate "trend" computation exists anywhere — this chart and the Last 5 text are two
presentations of the same underlying per-game numbers, so they will never disagree if you port
both; if they ever do, one of the two ports has a bug.

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

## Balance Teams — a planning tool, not new data

The Games tab has a **Balance Teams** panel: pick who's attending, set a team size, and it
generates up to 5 candidate splits ranked by fairness. Worth flagging separately because it's a
genuinely different kind of feature from everything else in this tool — a *before-the-fact*
planning aid rather than something computed off logged games, and its own selection state
(`balanceAttendeeIds`, a `Set`, and `balanceResults`, the last generated shortlist) is deliberately
**not persisted anywhere** — no `state` field, no `localStorage` key. Picking attendees and
generating options is meant to be throwaway per session; the only thing that becomes real data is
the game a user actually creates from a chosen split, at which point it's a completely ordinary
`teamA`/`teamB` game record indistinguishable from one built by hand through Create Game.

**The balancing currency is season Two-Way/20** (0 for a player with no games logged — a neutral
baseline, not a penalty), read straight from `computeLeaderboard()` — no new stat, no new
schema. For a chosen attendee list and team size, `generateBalancedTeamSets()` (`app.js`, in the
`---------- Balance Teams ----------` section) works out a team count (whichever integer is
closest to `attendees / teamSize`, minimum 2 — so 7 people at team size 3 becomes one team of 4
and one of 3, not three teams with one short) and a target size per team (attendees distributed
as evenly as the team count allows, so sizes never differ by more than 1). It then generates one
seeded "snake draft" candidate (`snakeDraftTeams()` — attendees sorted by quality descending,
dealt out in serpentine order across the teams, skipping a team once it hits its target size) plus
300 randomized ones (`randomGreedyTeams()` — random attendee order, each player greedily assigned
to whichever team with room has the lowest *running average* quality so far), dedupes identical
team compositions (`teamSetSignature()`), and returns the 5 lowest-spread survivors — spread being
`max(team average) - min(team average)` across the candidate's own teams (`scoreTeamSet()`).
Averages, not totals, is deliberate: with uneven team sizes a raw total would read a bigger team
as "stronger" even at identical per-player quality.

If you're porting this: it's pure client-side computation over data you already have (player
qualities, an attendee list from the UI), so there's genuinely nothing new to store or sync — the
whole feature is one read (`computeLeaderboard()`) and some in-memory search. The only write is
the ordinary game-creation path when someone clicks **Use These Teams** (only offered for an
exactly-2-team result, since that's the only case that maps onto a single `teamA`/`teamB` game);
for 3+ teams it's display-only, on the theory that a "day of games" with more than two groups
rotating through multiple actual games isn't something this tool tries to auto-create for you.

**A player with no dashboard stats logged gets a reputation-based fallback instead of a flat
0.0.** `PLAYER_REPUTATION_DATA` (`app.js`, right above the Balance Teams section) is a hand-typed
array — `{slug, avgPercentile, parties}` per player — imported from Ben's own
`poolean_player_profiles.xlsx` ("Power Rankings & Awards" sheet), the same frozen-external-
snapshot pattern as `AWARD_RESULTS`/`PARTY_RANKINGS` elsewhere in this file: not derived from
`state`, not auto-synced, edit it by hand if Ben sends a newer export. It is **not** the same data
as `PARTY_RANKINGS` — that array only covers the handful of dates tied to a game Ben's actually
reviewed (5 dates when this was written), while the spreadsheet's percentile is a full-season
average across every real-life party (up to 15 for some players), including many players with
*zero* entries in `PARTY_RANKINGS` at all. Don't try to derive one from the other; they answer
different questions (`PARTY_RANKINGS` powers the "Power Ranking vs. Performance" panel's per-date
pairing with that night's actual performance; `PLAYER_REPUTATION_DATA` powers this one single
season-long fallback number).

`computeBalanceQualityMap()` is the single source of truth for "how good is this attendee" —
real season Two-Way/20 for anyone with `gp > 0`, else `estimatedQualityFromReputation(avgPercentile)`
if they're in `PLAYER_REPUTATION_DATA` (`(avgPercentile - 50) / 10` — a single adjustable
constant, calibrated so a dominant 100th-percentile reputation lands around the top of this
roster's real Two-Way/20 range rather than some inflated outlier), else a neutral 0.0 same as
before. Both the attendee picker and the results re-derive this map on every render rather than
caching it, so it can never drift out of sync with `computeLeaderboard()`. The picker marks a
reputation-estimated player with a **\*** and a tooltip naming the source and percentile — worth
keeping if you port this, since silently blending a real stat with an estimate (even a
well-reasoned one) without flagging which is which would be misleading.

**`PLAYER_PHYSICAL_DATA` (`app.js`, right after `PLAYER_REPUTATION_DATA`) pulls in the
spreadsheet's "Player Profiles" sheet after all — at Ben's explicit request, reversing the
original "deliberately does not" stance above; that stance was about not doing this
*unprompted*, not a permanent rule.** Same hand-transcription pattern as
`PLAYER_REPUTATION_DATA`: a plain object keyed by player id, `{ heightIn, build, roles, note }`
per entry. `heightIn` is parsed by hand from the sheet's "Height/Build" column's feet/inches
(e.g. `6'0", 175 lbs` → `72`); `build` is Claude's own 1-5 read of that same column's
qualitative half (skinny through very muscular — a bare pounds figure like "175 lbs" isn't used
on its own, just folded into the same judgment call, since weight means nothing without a frame
to compare it against). `roles` is Claude's own five-bucket read of the "Preferred Role" column's
free text (`scorer` / `defender` / `physical` / `playmaker` / `role-player` — `physical` was
`rebounder` originally, renamed at Ben's request since it covers more than just rebounding),
stored as an array — an interpretation, not Ben's own explicit tag (though a few, like Adam's and
Zach's defense, are now Ben's own qualifiers added straight to the sheet's Preferred Role
column). Most players get one entry; a handful whose scouting clearly describes two distinct,
genuinely-strong contributions (e.g. Ben: "lockdown defender... facilitator/passer on offense" →
`["defender", "playmaker"]`) carry two — hedging language ("mediocre", "average", "fine") is
deliberately not enough to earn a second role on its own. Every consumer of `roles`
(`scorePhysicalBalance()`'s role-variance tally, the results UI's role-count summary and hover
tooltip, the Players tab tag list) treats a two-role player as counting toward both roles, never
splitting credit between them. `note` originally kept the scouting sentence a categorization came
from; cleared to `""` for every entry at Ben's explicit request, so tags display with no hover
text by default — still a real field (the editor below still writes to it), just empty out of
the box. A player missing from this table (no Player Profiles row) just doesn't contribute to
any part of what it feeds.

**`state.playerPhysicalOverrides` (`loadState()`, `app.js`) lets any of this be edited from the
Players tab instead of by hand-editing `PLAYER_PHYSICAL_DATA` in the source — added when Ben
asked for "the ability to edit tags in app."** A plain object keyed by player id, same shape as a
`PLAYER_PHYSICAL_DATA` entry. Every reader of a player's physical profile goes through
`getPlayerPhysicalData(id)` (`app.js`, right after `PHYSICAL_ROLE_LABELS`/`BUILD_LABELS`) —
`state.playerPhysicalOverrides[id] || PLAYER_PHYSICAL_DATA[id]` — never straight at
`PLAYER_PHYSICAL_DATA`, so a saved edit is picked up everywhere (Balance Teams' tiebreak, the
Players tab tag list) with one change. An override is a **whole-object replacement**, not a
partial merge: `renderPhysicalProfileEditor()`'s Save handler always writes all four fields
(`heightIn`, `build`, `roles`, `note`) together, so there's never a question of which fields came
from the sheet vs. the UI, and an edited role can never accidentally pair with a stale hardcoded
height. Reset to Default just `delete`s the override key, falling back to whatever
`PLAYER_PHYSICAL_DATA[id]` already had (or to no profile at all, for a player who was never in
the original sheet) — Start New Season never touches this key either, so an edited profile
survives a season close the same way the roster and games do.

**The Players tab itself (`renderPlayers()`) now shows a color-coded tag row per player, driven
by `physicalProfileTags(phys)`** — one `{label, kind}` entry per role. Height and build stay real
fields (still feed the Balance Teams tiebreak, still editable in the form below) but deliberately
aren't surfaced as their own tag here — an earlier version added a build tag too, walked back per
direct feedback that a roster scan doesn't need a "Strong"/"Skinny" chip alongside role. `kind`
maps straight to a `.profile-tag-<kind>` CSS class (`style.css`), each backed by its own
`--tag-*-bg`/
`--tag-*-text` custom property pair in `theme.css` (defined for light, `prefers-color-scheme:
dark`, and the explicit `data-theme="dark"` override, same three-block pattern every other token
in that file follows) — `role-player` deliberately has no dedicated hue and falls through to
`.profile-tag`'s own neutral default, since it's the "nothing stands out" catch-all rather than a
real specialization. **Edit Tags** toggles `renderPhysicalProfileEditor(p, phys)` open right
under that player's row (`editingPhysicalProfileId`, a module-level variable so it survives
`renderPlayers()`'s full-list rebuild on every add/remove/edit) — height as separate feet/inches
number inputs, build as a `<select>` over `BUILD_LABELS`, roles as one checkbox per
`PHYSICAL_ROLE_LABELS` entry, and a free-text note input.

**`renderPlayersRoleFilter()` (right above `renderPlayers()`) renders the same five role labels
as clickable `.profile-tag-<kind>.role-filter-chip` buttons above the roster** — `playersRoleFilter`
(a module-level `Set<roleKey>`) toggles membership per click and calls `renderPlayers()`, which
filters `state.players` down to anyone whose `getPlayerPhysicalData(id).roles` intersects the
set (OR semantics — any picked role matches, not all of them) before the existing name-sort and
row-render loop runs; an empty set (the default) shows everyone, same "no filter active"
convention as the Games tab's own Advanced Filters. `.role-filter-chip` reuses `.profile-tag-
<kind>`'s own color (so a chip's color always matches the tag it filters for) but dimmed via
`opacity` until `.active`, so an all-off "showing everyone" state doesn't read as five active
filters at once. Balance Teams' own team cards got the same tag treatment at the same time —
`renderBalanceResults()`'s per-team role-count summary (`roleCounts`) now renders as
`.profile-tag-<kind>` pills (`1 Defender`, `2 Scorers`, …) instead of a plain comma-joined string,
so the same role reads the same color everywhere it shows up in the app.

**Two mechanisms read `PLAYER_PHYSICAL_DATA`, both in `generateBalancedTeamSets()`, and both are
explicitly scoped to never override quality — Ben was direct about this when it was built:
Two-Way/20 (real or reputation-estimated, itself now also chemistry- and win-rate-adjusted — see
below) decides first, physical/role only breaks ties.**

`scorePhysicalBalance(teams)` (called from `scoreTeamSet()`) sums three components into one
`physicalScore` per candidate split, via a shared `avgOf(field)` helper: the spread between
teams' *average* height (weighted 0.75×, walked down from an initial 1× per direct feedback that
height "shouldn't be a gigantic factor"), the spread between teams' *average* build (also
weighted 0.75× — originally shipped at 2×, explicitly walked back after Ben flagged build as the
weakest of the three signals to lean on, then set equal to height's own weight per his follow-up
"make height and weight equal"; build is Claude's own coarsest read of the three, a single-digit
guess at vague prose like "decently sized") — both mirror `scoreTeamSet()`'s own
average-not-total reasoning, uneven team sizes shouldn't read a bigger team as automatically
"taller" or "stronger" — and, weighted 1.5× higher than either, the summed *variance* of each
role tag's per-team count, tallied via `(getPlayerPhysicalData(id)?.roles || []).includes(role)`
so a player with two roles (see above) counts toward each one's own variance independently (role
carries the most weight of the three; height and build are now tied for second, both
deliberately light). This score only ever gets consulted as a tiebreaker: `generateBalancedTeamSets()`
computes `tieTolerance = 0.1 + reputationShare * 0.9` (`reputationShare` = the fraction of
today's attendees who are reputation-estimated rather than `gp > 0`), then re-sorts only the
best-spread candidates (`scored.slice(0, 30)`, not the full 300+ pool, so the tolerance check
can't produce a weird ordering between options that were never close to begin with) with a
comparator that falls through to `physicalScore` only when `Math.abs(a.spread - b.spread) <=
tieTolerance`. The tolerance scaling with `reputationShare` is deliberate: quality estimates
built mostly from reputation percentiles are themselves mostly a guess, so two such options
within a full point of each other are treated as practically indistinguishable on quality alone,
handing real say to physical/role — whereas a group with real measured Two-Way/20 for everyone
gets a near-zero tolerance (0.1), so physical/role essentially never overrides a real quality
difference there.

One height rule sits a level above that tiebreak, closer to a guideline than a nice-to-have, per
Ben's own framing ("fundamental... although not completely strict"): `averageAttendeeHeight()`
and `teamHasAboveAverageHeight()` check whether every team in a candidate has at least one player
taller than *today's attendee group's own average* (not the whole roster's) — `null` (skipped
entirely) if nobody in the group has height data at all. This is folded into the same
tie-tolerance comparator, checked *before* `physicalScore` (so it's the stronger of the two
tiebreak signals) but still only within the tolerance window — a candidate that's genuinely
better-balanced on quality outside that window still wins even if it fails the height check. This
was a deliberate design choice, not a hard filter: an earlier version excluded non-qualifying
candidates outright before any spread sorting, and was explicitly walked back to this
softer version — worth knowing if you're tempted to port the "obviously correct" strict version
instead.

**Chemistry is the one place past games actually move the *primary* ranking, not just settle
close calls — this was the second half of the same request that added `PLAYER_PHYSICAL_DATA`.**
`computeChemistryLiftMap(attendeeIds)` (`app.js`, right before `generateBalancedTeamSets()`)
calls `computeTeammateSynergy(playerId)` once per attendee (not once per pair per candidate —
that function already re-scans every game per call, so this keeps the cost affordable) and
builds a flat `"playerId|teammateId" -> dampened lift` map from every pair where both players are
in `attendeeIds` and both `with.gp` and `without.gp` are nonzero. The lift itself is
`with.twoWayPer20 - without.twoWayPer20` (identical to what Player Detail's own Teammate Synergy
panel shows), dampened by `Math.min(1, with.gp / 3)` — a pair who's shared only one game gets a
third of their raw lift's weight, three or more games gets the full lift, since a single shared
game's swing shouldn't be treated as a settled pattern. A pair with zero shared games gets no
entry at all (not a zero — unknown, not assumed neutral). The map is intentionally asymmetric:
`liftMap["a|b"]` and `liftMap["b|a"]` are separate lookups with generally different values, same
as the Teammate Lift Matrix's own row/column asymmetry, since "how did A do with B" and "how did
B do with A" are different facts about different players' games.

`teamChemistryAdjustment(team, liftMap)` returns `{ value, minGp }`, not a plain number: `value`
averages every known pairwise lift among a team's own players (both directions counted
separately), and `minGp` tracks the smallest `gp` (games together) among the pairs that
contributed to that average — the weakest-tested pairing driving the number, surfaced so the UI
doesn't quietly treat a single shared game the same as ten. `scoreTeamSet()` adds `.value`
directly to each team's base quality average *before* computing `spread` — meaning a strong
observed chemistry effect between two attendees can change which split ranks best, not just which
one wins a tiebreak among near-equal options. `computeChemistryLiftMap()` is computed once per
`generateBalancedTeamSets()` call (all candidates share the same attendee pool, so the same map
applies to every one of them) and passed through to `scoreTeamSet()` per candidate.
`renderBalanceResults()` recomputes the same map once more for display (a `Chemistry: ±X.X (min N
games together)` line on any team card where `Math.abs(adjustment.value) >= 0.1`) — cheap enough
at this attendee-pool size that a second call isn't worth threading the first one through as extra
render-function state.

**`computeTeamWinRateMap(attendeeIds)`, right after the chemistry functions, is the second half
of the same "past teams, not just past scores" request — whether teams built around a given pair
have actually won, as a signal independent of either player's own individual performance.**
Symmetric by construction (a pair's win/loss record while sharing a team is one fact, not two —
`liftMap`'s `"a|b"`/`"b|a"` asymmetry doesn't apply here), so it's a single `O(n²)` nested loop
over `attendeeIds`, storing one entry per unordered pair (`i < j`) rather than two. For each
pair, it filters `state.games.filter(isQualifyingGame)` down to games where both were on the same
side, tallies W/L/T via `playerGameResult(g, a)` (same result for `b`, since they shared a team
that game), and converts the resulting win% to a Two-Way/20-scale adjustment with `((winPct - 50)
/ 10) * confidence` — deliberately the exact same `(x - 50) / 10` shape
`estimatedQualityFromReputation()` already uses elsewhere in this file, reusing an established
calibration (10 percentage points ≈ 1 point of Two-Way/20) rather than inventing a new one. Ties
count as half a win in `winPct`, matching how win% is computed everywhere else in this tool.
`confidence` is the same `Math.min(1, gp / 3)` dampening curve as chemistry's, for the same
reason — a 1-2 game record isn't settled yet — and a pair with zero shared games gets no entry at
all. `teamWinRateAdjustment(team, winRateMap)` returns the same `{ value, minGp }` shape as
`teamChemistryAdjustment()`, for the same reason: `value` averages every known pairwise entry
among a team's own players (looking up whichever of `"a|b"`/`"b|a"` the ids sort into) and
`scoreTeamSet()` *sums* `.value` with `teamChemistryAdjustment()`'s own `.value` — not an average
of the two — into the same primary-ranking nudge: a pairing that's both shown a real individual
lift *and* a real winning record together is doubly-confirmed by two independent signals, not
double-counted, since each is already dampened by its own sample size before the two are
combined. Shown in the UI as its own `Past record: ±X.X (min N games together)` line, same `>=
0.1` display threshold as Chemistry, right underneath it on each team card.

**`localSearchRefine(teams, qualityById, liftMap, winRateMap, iterations)` (`app.js`, right
before `generateBalancedTeamSets()`) closes a gap the post-hoc scoring above leaves open: chemistry
and win-rate only ever entered the picture when scoring whatever `randomGreedyTeams()` happened to
generate, which only ever optimizes individual quality while building a candidate — a split that
would've been genuinely great on chemistry or past record could go completely ungenerated.**
`generateBalancedTeamSets()` takes the best 30 candidates by the initial quality+chemistry+
win-rate `spread`, and for each one calls `localSearchRefine()`, which deep-copies the team
arrays and, for `iterations` (30 candidates × 25 iterations each in practice) attempts, picks two
random teams and one random player from each, tries the swap, rescoring via
`scoreTeamSet(...).spread`, and keeps it only if the spread drops — a simple hill-climb, not an
exhaustive search, refining already-decent starting points rather than searching from scratch.
The refined candidates are deduped (`teamSetSignature()`) and re-sorted the same way as the
original pool, and `generateBalancedTeamSets()`'s final `pool` (the one the tie-tolerance +
height-floor comparator sorts) is built from this `refined` array, not the original `scored` one.
Deliberately targets `spread` only, never `physicalScore` — height/build/role stay a pure
post-hoc tiebreak, untouched by this refinement step, same as before.

**Matchup Preview, on any 2-team Balance Teams result, is not new data either — it's
`computeMatchupGrid()`'s existing per-pair FG data, filtered down to one specific matchup.**
`computeCrossTeamMatchups(teamA, teamB)` (`app.js`, right before `renderBalanceResults()`) calls
`computeMatchupGrid()` once and reads `cellFor(scorerId, defenderId)` for every cross-team pair in
both directions (team A shooting on team B's defenders, and the reverse) — same-team pairs are
skipped outright, not shown as empty cells, since teammates never guard each other in the game
about to happen. `renderMatchupPreviewTable()` turns that into a small sorted table (most-tested
pairing first); `renderBalanceResults()` wires a **Preview Matchups** button per 2-team option
that toggles a `hidden` wrapper div rather than re-rendering on each click, since the content
itself never changes for a given generated split. If you're porting the underlying grid data
(`computeMatchupGrid()`) anyway for the league-wide version, this is a free extra view on top of
it — no separate query.

**Player Comparison (Leaderboard tab, right below the main table) is `LEADERBOARD_COLUMNS`
rendered sideways for exactly two players — the same array (accessor/display/tooltip, unchanged),
just iterated as table rows instead of table columns, with `"player"` and `"last5"` skipped** (the
row label already names the player; Last 5's `"▲ 3.9"`-style display string doesn't reduce to one
comparable number the way every other column does). `renderPlayerComparisonSelects()` rebuilds
just the `<option>` lists on every Leaderboard render (cheap; the `change` listeners are wired
once, directly on the `<select>` elements, so they survive that); `renderPlayerComparison()` reads
both selections, looks up each player's row from `computeLeaderboard()`, and for each column calls
its own `accessor`/`display` on both rows. Always shows all columns regardless of the main table's
own advanced-columns toggle — a two-column-of-values comparison doesn't have that table's
34-column width problem, so there's no reason to hide anything here. The green/red "which is
better" coloring is **not** part of `LEADERBOARD_COLUMNS` itself — it's two small local sets,
`COMPARISON_NEUTRAL_KEYS` (GP + the five share percentages, where a bigger share is a role, not
inherently better play) and `COMPARISON_LOWER_IS_BETTER_KEYS` (L, TOV, PF, Pts Allowed, Opp FG%,
Beaten, TOV%) — everything else defaults to higher-is-better. If you add a new Leaderboard column
later, decide which of these three buckets it belongs in the same way; nothing auto-detects
direction from the stat's own shape.

**Games tab Advanced Filters is client-side only, no schema implications, purely additive to the
existing free-text filter (both apply together, AND'd).** Collapsed behind its own toggle
(`toggleGamesAdvancedFilterBtn`, a `hidden` panel) so the default one-line filter box stays the
common case. Four independent conditions, all in `app.js` right before `renderGames()`:
`gamesFilterPlayerIds` (a `Set`, chip-picker same as Balance Teams' attendee picker) requires
every checked player to be on the game's combined roster; `gamesFilterTeamMode`
("either"/"together"/"against") only does anything with 2+ players checked — "together" requires
all of them on the same side, "against" requires at least one on each; `gamesFilterDateFrom`/`To`
are a plain inclusive date-string range; `gamesFilterStat` (`{playerId, field, op, value}`) is a
single condition — `getGameStatValue(game, playerId, field)` reads PTS/OREB/DREB/AST/STL/BLK/TOV/PF
straight off `getOrCreatePlayerStats()`, or computes Off Rating/Two-Way via
`offensiveRating()`/`twoWayScore()` for that one game, same per-game helpers Game Stats itself
uses — never a stored or season-level number. `gameMatchesAdvancedFilters(game)` combines all
four (each is a no-op when unset); `Clear Filters` resets every field, both the JS state and the
DOM inputs, then re-renders. No interaction with `isQualifyingGame()` — this filters which games
*display* in the list, not which count toward a computed stat, so an imbalanced or archived game
is still findable here even when it's excluded from the Leaderboard.

**The Games list card itself picked up two more things, both purely display, no new state.**
The matchup line now joins `game.teamA`/`teamB` player names directly (`.map(id =>
state.players.find(...).name).join(", ")`, falling back to the literal string "Team A"/"Team B"
only when a side has no roster yet) instead of always showing the literal "Team A"/"Team B"
labels. And once `game.scoringEvents.length > 0` with at least 2 rostered players, the card
computes `twoWayScore(s, sh, def)` for every player on the combined roster (same per-game
helpers Game Stats and the Advanced Filters stat-line condition both already use) and shows the
max as a 🔥 `.badge-highlight` and the min as a 👎 `.badge-lowlight` — the exact same number and
formula Best & Worst Individual Games ranks the whole season by, just computed for this one
game's own roster instead of pooled. Both skip entirely (not a placeholder dash) when there's
nothing to rank yet, or when best and worst would be the same single player.
