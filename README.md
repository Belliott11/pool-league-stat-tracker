# Pool League Stat Tracker

A static, no-build-step dashboard for entering box score stats and defensive matchups while
watching game video. Open `index.html` in a browser — no server needed. Data is saved to the
browser's localStorage automatically as you go.

**Integrating this into poolean.adammirmina.com?** See [`INTEGRATION.md`](INTEGRATION.md) —
it documents the data model, proposes a PocketBase schema, and flags the open questions (team
rosters possibly already existing in your backend, where video actually gets hosted) before you
start wiring it up.

It follows your system's light/dark preference automatically; click the 🌙/☀️ button in the
header to override it (saved per browser).

Teams are picked fresh each game, so there's one league-wide **player roster**, and each game
assigns players to "Team A" / "Team B" just for that game. All the real stat totals live on the
individual player, not a team.

## Workflow

1. **Players** — add everyone in the league once.
2. **Games** — create a game (date, optional video URL, notes), then click it to open Stat Entry.
   Games are listed in chronological order (oldest first), and any game with a video attached
   (URL or local file) shows a 🎥 badge, so you can spot at a glance which ones are ready to score.
   A game with video but nothing logged yet also gets a 📝 **Needs Review** badge, and the count
   at the top of the list ("📝 N games with video still need review") tracks your backlog across
   all of them, independent of whatever the filter box below is currently narrowed to — a game
   with no video at all doesn't count toward this, since there's nothing to review yet. Once the
   list gets long, use the filter box to narrow down by date, notes, or any rostered player's
   name.
3. **Stat Entry** — this is where you sit while reviewing the video:
   - If one recording covers several games back-to-back, use **Session video**: upload it once
     under any of those games (give it a name when prompted) and then pick that same session
     from the dropdown on the other games — each game just remembers its own start time in the
     shared recording (type a time, or scrub/play the video and click **Set From Current
     Playback Position**), so you never have to split the file into separate clips. You can
     optionally also set an **end** time the same way (or leave it blank, meaning "runs to the
     end of the recording") — it's just a marker, mostly useful for later splitting the shared
     recording into individual per-game clips, and doesn't affect playback in this tool (no
     auto-pause). The blob is stored once in IndexedDB regardless of how many games use it.
     Manage or remove session videos from **Export → Session Videos** (removing one detaches it
     from every game using it). If a game's `masterVideoId` ever ends up pointing at a session
     video that no longer exists here (say, from an import, or a browser profile change) the
     video panel just quietly shows nothing useful — nothing errors, so it's easy to miss.
     **Export → Broken Session Video Links** lists any game in that state so you can reattach
     the right recording, with a button that opens the game directly.
   - Otherwise, click **Choose Video File** under "Or a video just for this game" and pick the
     downloaded game video — it plays right in the browser and is remembered for that game on
     this computer (stored via IndexedDB), so you won't have to re-pick it next time. Either way,
     video never leaves the browser and isn't included in exports, since video files are too
     large for that. If the video is hosted somewhere instead (YouTube, a direct link), paste
     the URL and click Load URL. Once a video's loaded, **← / →** seek it 5 seconds back/forward
     from anywhere on the page — skipped while you're typing in a field, so it doesn't hijack
     the cursor there.
   - Add players to Team A / Team B from the "+ Add player…" dropdown under each team (it only
     lists players not already on either team); click the &times; on a chip to take someone
     out of the game.
   - Click +1/+2/+3 (make) or one of the **MISS** buttons on a player, then pick **who was
     contesting the shot** — any number of opposing players (for a double-team; toggle names on
     and off, then **Confirm**), or leave none selected for **No defender** if nobody was
     responsible (open shot, broken play, etc.). For a 2 or 3 (not a free throw), you'll also
     see a small **shot chart** — click it to mark roughly where the shot was from, or leave it
     unmarked and click **Clear location** if you change your mind. It's a plain rectangle at
     the pool's actual proportions (~30ft end to end by ~15ft wide, a 2:1 ratio) with a hoop at
     the bottom and a dashed line at 60% depth for the 3pt threshold (Poolean has no paint or
     free-throw line to draw). It's purely informational, logged alongside whatever
     point value you picked — it doesn't decide or override 2 vs. 3 for you, so if you mark a
     spot past the line but picked +2 (or vice versa), the Shot Log flags that with a small
     "📍 2PT range" / "📍 3PT range" badge as a sanity check, not a correction. On a make,
     you'll also see **Assisted by?** —
     pick the one teammate who passed to them, or **No assist**; this section doesn't show up on
     a miss, since misses can't be assisted. On a miss, you'll instead see **Blocked by?** — pick
     the one opponent who blocked it, or **No block** — and **Where did it end up?** — **Live
     ball** (default) or **Out of bounds (turnover)**, which auto-logs a turnover for the
     shooter, same as a steal auto-logs one for its victim. On a live-ball miss only (out of
     bounds is a dead ball, so it's hidden then), you'll also see **Rebounded by?** — pick who
     grabbed it from either team, or **No rebound tracked**; a teammate's rebound counts as
     OREB, an opponent's as DREB, decided automatically from which team they're on. PTS, AST,
     BLK, OREB, and DREB are all a sum of tagged shots, not plain counters — those cells in the
     box score are read-only for that reason, driven entirely by who you tag here, not their own
     +1/- buttons. A double-teamed shot counts fully against
     *every* tagged defender, not split between them, so a defender's Pts Allowed/Beaten/Opp FG%
     mean "shots this player was involved in defending" — summed across all defenders in a game,
     that can exceed the game's actual points, which is expected once a shot can count for more
     than one person. Every attempt (make or miss) shows up in the **Shot Log** below the box
     score, where you can remove any entry, not just the most recent one. The "-" button on a
     player's PTS cell undoes their most recent *make* (misses are removed from the Shot Log).
     Click **Edit** on a Shot Log row to fix the tagged defender(s), assist, block, or
     rebounder after the fact, without deleting and re-logging the whole shot — it's the same
     picker, just editing the existing entry in place instead of creating a new one. It doesn't
     cover make-vs-miss, points, or the out-of-bounds turnover link, since changing any of those
     changes what other records exist (the linked turnover, the derived PTS) rather than just
     who's tagged — for those, remove and re-log the shot.
   - Click **+1 on STL** and pick who it was stolen from — a steal is always also a turnover for
     that player, so this logs *both* automatically; you don't separately click TOV for them.
     Click **+1 on TOV** for a turnover that *wasn't* a clean steal (a travel, a bad pass out of
     bounds, an offensive foul) and optionally tag who forced/recovered it, or pick **No one
     tagged** if it doesn't apply. Click **+1 on PF** and pick who was fouled, or **No one
     tagged** for a team foul. Unlike shot defenders, all three are single-select — a
     turnover/steal/foul only ever involves one other player, no double-teams to account for.
     Every one shows up in **Other Events** below the Shot Log (a turnover created by a steal is
     labeled "via steal" there), where you can remove any entry — removing either half of a
     steal/turnover pair removes both, so they can't drift out of sync. The "-" button on a
     player's TOV/STL/PF cell undoes their most recent one the same way. A player's PF cell (in
     the Game Stats table here, and in their Game Log on Player Detail) gets a red **OUT** badge
     once it hits 3 for that game — Poolean's actual rule is 3 fouls ejects a player for the rest
     of the game, so this is just calling that out where you're already looking, not enforcing
     anything.
   - Every logged event — shots, turnovers, steals, fouls, and matchup entries — automatically
     captures the video's playback position the moment you log it. Each shows a **Time** column
     and a **▶ Jump** button in its table (Shot Log, Other Events, Defensive Matchups) that seeks
     the video right back to that instant, so you can re-watch any specific play later without
     hunting for it. This needs a local video file or a direct video link loaded (the ones that
     play as an actual `<video>` element) — a YouTube embed can't be read for its playback
     position, so events logged against one just won't have a time.
   - The **Game Stats** table (between the box score and the Shot Log) rolls all of this up per
     player for the game: FG/3PT/FT splits with %, **eFG%** (FG% weighted so 3s count extra),
     **TS%** (true shooting — overall scoring efficiency across FGs and FTs combined),
     assist-to-turnover ratio, and defensive numbers derived from who was tagged as the defender
     in the Shot Log — **Pts Allowed** and **Beaten** (points scored, and times scored on, while
     they were the defender on a *make*), **Opp FG%** (shooting % of everyone they were tagged
     defending, make or miss — a real "shooting percentage allowed"), and **Stops** (times they
     were the defender on a *miss*). **GmSc** (Game Score) rolls the whole box score into one
     "how good was this game" number, adapted from the standard basketball formula. **Two-Way**
     extends that with defense: it's GmSc plus **Defensive Impact** — `Stops − Beaten −
     0.4×Pts Allowed` — weighting a Stop the same as GmSc weights a steal, Beaten as its direct
     negative counterpart, and Pts Allowed lightly (0.4) just so a 3-point beat scores worse than
     a 2-point beat without double-penalizing the same possession the Beaten count already
     covers. Opp FG% isn't its own term in the formula since it's just Beaten ÷ (Beaten + Stops)
     — a separate term would double-count the same information. A player never tagged as a
     defender has Stops/Beaten/Pts Allowed all at 0, so their Defensive Impact is 0, not a
     penalty — conservative tagging (only tag a defender when it's genuinely clear) should never
     hurt a player's Two-Way Score. The season **Leaderboard** shows every one of these as a
     rate per 20 combined points across all games, not a raw season total — see
     `defensiveImpact()`/`twoWayScore()` in `app.js`. STL and BLK are shown as recorded; their
     sum ("Stocks") isn't repeated as its own column in either table since it's just those two
     added together, but it is in the CSV exports.
   - Add defensive matchup entries (who guarded who, with an optional note like "Q1") as they change.
     This is separate from "scored on" — matchups are about who was generally guarding who,
     while the scoring log is specifically about who got beaten on each made basket.
   - **Highlight / Lowlight Reel** — while the video plays, click 🔥 **Mark Highlight** or
     👎 **Mark Lowlight** to grab a ~10 second clip centered on the current playback time (5s
     before to 5s after). Each marked clip shows up in the table below, where you can nudge its
     start/end times, tag which player it's about, add a note, jump the video back to it, or
     remove it. This only works with a local video file or a direct video link (the ones that
     load as an actual `<video>` element) — a YouTube embed can't be read for its current time.
4. **Leaderboard** — every counting stat as a season-wide *rate per 20 combined points scored in
   the game*, not a raw total or a per-game average, plus **W-L record and win %** per player (a
   game counts as a win/loss/tie for everyone on the winning/losing/tied team, since teams
   reshuffle every game — there's no team standings, just individual record). Only a game with
   real shots logged counts toward a player's row at all — one that's just been rostered but not
   reviewed yet doesn't drag their numbers toward 0, and a player with no such games doesn't
   clutter the table with a row of dashes. **Click any column header to sort by it** (click again to flip
   between highest-first and lowest-first) — hover a header for a sentence on what that column
   means, since 25+ columns is a lot to hold in your head while staring at a number. The last
   column, **Last 5**, is a quick "how are they trending lately" read: GmSc/20 over just their
   last 5 games with real shots logged (fewer if they haven't played 5 yet), with a ▲/▼ showing
   whether that's above or below their season GmSc/20 (within ±0.5 counts as flat, shown as ●
   rather than a dash, since a dash next to a number reads as a minus sign).
   Below the table, **Awards vs. Stats** lines up Summer 2026's voted awards (MVP, DPOY, Clutch,
   Most Improved, Best Teammate, First/Second Team, Best/Worst Duo — from that season's closed
   ballot, a fixed historical record, not something this tool derives) against whichever tracked
   stat is the closest comparison for that award: **MVP** compares season-long total Two-Way
   Score (not a per-20 rate) — durability and total contribution should count for MVP, not just
   rate over however many games someone happened to play. **Best Player**, **First/Second Team**,
   and the duo awards compare Two-Way/20 rank instead; **DPOY** compares Def Impact/20 rank;
   **Most Improved** compares the Last 5 trend (Two-Way/20, same mechanism as the Leaderboard's
   own Last 5 column, just using Two-Way instead of GmSc here); **Best Teammate** compares the
   average Two-Way/20 lift that player gives their actual teammates (each teammate's own
   With/Without split, same source as the Teammate Synergy panel on Player Detail) — a duo award
   also shows how many assists actually happened between that pair. **Clutch** compares
   **Game-Winning Buckets** (see below) rather than being left blank, now that there's a tracked
   stat that actually fits it. Every number here is computed live from whatever games are
   actually logged in this browser, so it's only ever as complete as your Shot Log is — a vote
   sitting outside the top of its column isn't a bug, the vote and the numbers are allowed to
   disagree, that's the whole point of comparing them. A voted player who isn't in your current
   roster (nobody's added them yet, or they were a guest) shows as "not in current roster"
   instead of erroring. Click **▼ See standings** on any award to expand two full ranked lists
   side by side: **How the vote went** — every candidate who got at least one vote and their
   Borda point total, straight from that season's actual ballot tally (not just the winner) —
   next to **Stat standings**, the same tracked-stat ranking the winner's own line summarizes,
   for everyone instead of just them. The vote list is a fixed historical record like the winners
   themselves; the stat list is live. Seeing them side by side is the actual point of this
   panel — a vote and the numbers landing in a different order isn't a bug to fix, it's the
   answer to "did the numbers back up the vote." Click **▲ Hide standings** to collapse it again.
   Below that, **Game-Winning Buckets** counts, per player, how many times their shot actually
   closed out a game their team won — the real game-ending basket in Poolean's race-to-a-target
   format. Credited only when *every* made shot in that game has a real video timestamp — a
   single untimed shot could have happened at any point, early or late, so a partial set of
   timestamps can't reliably say which shot was really last. That's a real limitation, not a
   preference: a game logged without timestamps (or with just a few) will never contribute here,
   even if you're certain from memory which shot actually won it. A season count, not a rate,
   since a rate would round a rare, memorable thing down to an unreadable decimal.
   Below that, a **League Shot Heatmap** plots
   every marked field goal, league-wide, into a coarse 5×6 grid at the pool's real proportions
   (~30ft by ~15ft, 2:1), hoop at the *bottom* like the shot chart, which reads more naturally
   for something you're studying rather than clicking shots onto. The rows aren't evenly spaced —
   one row boundary lands exactly on the 3pt line, so a zone never straddles it and blends a 2PT
   FG% together with a 3PT one; there are 4 tighter rows inside the arc and 2 looser ones beyond
   it, since that's where shot volume actually concentrates.
   Each zone is colored by FG% there (red low, green high) and labeled with attempts plus the
   exact FG% underneath, blank until at least one shot lands in it (the hoop marker itself draws
   behind the grid, so it only shows through an empty zone — it never covers a number). Only
   shots with a marked location count
   (see **Export → Backfill Shot Locations** to fill in the rest). Below that, **Assist
   Connections** lists every passer-to-scorer pairing, league-wide, with how many times each has
   happened — directional (Alice assisting Bob is a separate row from Bob assisting Alice) — a
   straight readout of the Shot Log's assist tags, sorted by count. (There's deliberately no
   win/loss duo table here — the real Poolean site already tracks that.) Below that, **3PT Shot
   Distance** splits every player's 3-pointers further by how far past the line they actually
   were — a shot right at it (**Line**) is a normal, makeable three; a much longer near-pool-length
   heave (**Deep**) is a different, lower-percentage shot the plain 3PT% column blends in with it.
   ("Line" rather than "Arc" for the shorter-range bucket, since Poolean's three is a straight
   line, not a curved arc.) Split by radial distance from the hoop (`√((x-50)² + y²)` in the shot chart's own 0-100
   coordinates, not real feet) against a threshold of 80 units — a single adjustable constant
   (`THREE_PT_DEEP_THRESHOLD` in `app.js`), drawn from an early, small sample, not a settled rule.
   Only 3-pointers with a marked shot location count (see **Export → Backfill Shot Locations** to
   fill in the rest); kept in its own panel rather than as more columns on the main table above,
   since it's a cut most people only need occasionally. Below that, **Out-of-Bounds Misses**
   shows how often a player's own missed shot ends up out of bounds — per Poolean's actual rule,
   whoever last touched the ball loses possession, so this is really "how often does the ball
   leave their hands for good on a miss," not a shooting-accuracy stat. Misses are the
   denominator, not total shots, since a make can never go out of bounds; a league-wide line
   above the table gives the same rate across everyone, for context. Click a player's name to
   open their **Player Detail** page:
   - **Shot Heatmap** — the same grid, scoped to just this player's marked field goals across
     every game.
   - **Highlights & Lowlights** — every clip tagged to this player, across every game, pulled
     from the "Player" dropdown on each clip in the Highlight/Lowlight Reel table in Stat Entry.
     A "Go to game" button jumps to that game so you can load/rewatch it.
   - **Game Log** — every game they've played, most recent first, with the same full stat line
     (shooting splits, eFG%/TS%, defensive numbers, Game Score, Two-Way) as the Game Stats
     table, plus that game's W/L/T result. Unlike the Leaderboard, this is per-game actuals, not
     averaged — one row per game, exactly what happened in it.
   - **Head-to-Head** — two tables built from the Shot Log across the whole season: their
     shooting *against* each defender who's guarded them, and the shooting they've *allowed* to
     each scorer they've defended. This only reflects shots where a defender was actually
     tagged — untagged ("No defender") shots don't attribute to anyone.
   - **Teammate Synergy (With/Without)** — for each teammate this player has shared a team with,
     this player's *own* GmSc/20 and Two-Way/20 in games **with** that teammate on their side vs.
     games **without** them (opposing team, or not playing that game). This is about whether this
     player's own output actually changes with a given teammate around — not a shared win/loss
     record — so a teammate they've always played with shows "—" on the without side rather than
     a misleading 0.0, and a small GP on either side is a small sample, not a verdict.

   How W/L is decided for *one game* (shown per-row in Game Log, and on that game's own
   scoreboard): once real shots are logged (the Shot Log is non-empty), the actual score is
   authoritative. Before that, it falls back to a historical `winner` field if the game was
   imported with one (`poolean-seed.json` includes this from the original spreadsheet's
   `WINNER` column) — otherwise the game just doesn't have a result yet, rather than showing as
   a misleading 0-0 tie. The season-wide **W-L record on the Leaderboard is narrower**, though:
   it only tallies games with real shots logged, same as every rate column (see below) — a
   historical-only game contributes its own result to that specific game's row in Game Log, but
   not to the aggregate record shown on the Leaderboard, until it's actually reviewed.

   Every counting stat on the Leaderboard — PTS, OREB, DREB, AST, STL, BLK, TOV, PF, Pts
   Allowed, Beaten, Stops, Def Impact, GmSc, and Two-Way, plus the FG/3PT/FT makes-attempts
   shown — is normalized *per 20 combined points scored in the game*, not per game and not a
   raw season total. Games are capped at different totals (16 or 21), so a simple per-game
   average isn't a fair comparison between a player who mostly plays 16-point games and one who
   mostly plays 21s — normalizing by the game's combined final score (our stand-in for "how much
   game happened," since possessions aren't tracked) fixes that uniformly, not just for points
   and Game Score. 20 is just a round number near the middle of 16–21, chosen for readability,
   not because it's meaningful on its own. A/TO and the shooting percentages (FG%/3PT%/FT%/eFG%/
   TS%/Opp FG%) are untouched by any of this since they're already ratios — dividing both sides
   by the same normalizer cancels out.
5. **Export** — download data for your friend to pull into the website:
   - **JSON** (all data, or a single game) — full structured dump, easiest for a website to
     consume directly. A single-game export has no sibling `masterVideos` array to resolve
     `masterVideoId` against the way the full export does, so it embeds the one relevant entry
     inline instead, as `masterVideo` (`{ id, name, fileName }`, or `null` if the game isn't on
     a session video) — otherwise `fileName` never actually reaches anyone reading just that one
     file.
   - **Box Score CSV** — one row per player per game (with a Team A/B label for that game),
     including that game's Game Score and Two-Way Score, and the 3PT Arc/Deep split
     (`tp_arc_m`/`tp_arc_a`/`tp_deep_m`/`tp_deep_a`) alongside the plain `tpm`/`tpa`.
   - **Shot Log CSV** — one row per shot attempt (make or miss), with the shooter, result,
     points, who (if anyone) assisted it, who (if anyone) was contesting (multiple defenders
     joined with "+"), who (if anyone) blocked it, whether it went out of bounds for a turnover,
     who (if anyone) rebounded it and whether that was an OREB or DREB, the marked shot location
     if any (`shot_x`/`shot_y`, each 0-100, blank if unmarked or a free throw), which 3PT band it
     falls in if it's a marked 3-pointer (`three_pt_band`: `arc`/`deep`/blank), and the video
     timestamp it was logged at (seconds and mm:ss, blank if none).
   - **Shot Locations CSV** — a focused subset of the Shot Log: only shots with a marked
     location (`shot_x`/`shot_y` are never blank here), with just the player, team, make/miss,
     points, and video timestamp alongside them. Meant for handing off exactly what a shot chart
     needs, without asking whoever's building it to filter out the unmapped rows themselves.
     Free throws are never in this file, since they don't carry a location at all.
   - **Other Events CSV** — one row per turnover/steal/foul, with the type, who did it, the
     tagged opponent (if any), and its video timestamp.
   - **Matchups CSV** — one row per defensive matchup entry per game, with its video timestamp.
   - **Highlight Reel CSV** — one row per marked clip, with type, start/end time (seconds and
     mm:ss), tagged player, and note. Your friend uses these timestamps to actually cut the clips
     from the source video file — the dashboard only marks *where* the clips are, since it can't
     export video itself.
   - **Leaderboard CSV** — season totals per player (across the same stats-logged-only games the
     page itself counts), including the 3PT Arc/Deep split, plus PTS/20, GmSc/20, and Two-Way/20.
     Not the per-20 rates the Leaderboard page displays for every other counting stat — the CSV
     keeps raw totals plus `games_played`, so anyone consuming it can derive whichever rate or
     average they want without losing precision to a pre-divided number.
   - **Assist Connections CSV** — one row per passer-to-scorer pairing with at least one assist,
     directional, with the assist count.
   - **Teammate Synergy CSV** — one row per (player, teammate) pair across the whole league —
     the same With/Without split as the Player Detail table, for every player at once. GP and
     GmSc/Two-Way per 20 columns are blank on whichever side (with/without) has zero games.
   - **Out-of-Bounds CSV** — one row per player with at least one missed shot, with their miss
     count, how many of those went out of bounds, and the resulting OOB%.

Use **Import JSON** to restore/move data between browsers or machines (e.g. hand the whole
dataset file to your friend, or move from your laptop to another computer).

**Backfill Shot Locations**, also under Export, is for catching up games that were logged
before the shot chart existed (or any field goal you skipped marking at the time). It lists
every field goal missing a location, across every game, grouped by game — each group loads that
game's own video once (session video, local file, or a direct link; not YouTube, which can't be
seeked programmatically) so you're not marking a spot from memory. Click **▶ Watch** on a shot
to jump that group's video to the moment it happened, then click the mini shot chart next to it
to mark the location. Each click saves immediately and that shot drops off the list — clicking
one doesn't reload or interrupt any other group's video, so you can jump between games without
losing your place in whichever one you were watching. Misclick? **Undo** appears next to the
list for a few seconds after every click and puts that one shot right back to wherever it was
before — unmarked, or its previous spot if you were correcting an already-marked one. That's
also there for the case Undo's grace period doesn't cover: realizing an already-marked shot was
wrong after the fact. Check **Show already-marked shots too** above the list to bring those back
into view (each shows its current dot) and click straight through to a new spot to fix it — no
need to remember which shot it was or dig through the Shot Log to find it.

**Flagged Shot Locations**, right below Backfill, is Backfill's counterpart for the opposite
problem: every marked 2PT/3PT shot where the spot disagrees with the point value you picked at
logging time — the same mismatch the Shot Log flags one row at a time with a "📍 2PT range"/
"📍 3PT range" badge, collected here so a whole season's worth can be caught in one pass instead
of noticed by accident while scrolling. Same video-per-game, click-to-remark, Undo-toast
mechanics as Backfill. Re-marking a shot to a spot that now agrees with its point value drops it
off the list; re-marking to a spot that's still on the wrong side just redraws the dot and it
stays flagged. If the *point value* was actually the mistake (not where you clicked), this tool
can't fix that — remove and re-log the shot from the Shot Log instead, since a shot's points
isn't something either backfill tool edits in place.

## Starting from your existing Poolean data

`poolean-seed.json` in this folder was generated from your `pooleansummer2026season.xlsx`
export — it has all 21 players and the 33 games from July 29 onward (earlier games were dropped
since there's no footage for them), with team rosters and dates already filled in (`id` for each
player/game matches the `SLUG` / `GAME_ID` from the export, so your friend can join this data
back to the PocketBase records by that same key). Stats and matchups start empty — that's what
you'll fill in per game while watching video.

To load it: open the dashboard, go to **Export → Data Management → Import JSON**, and pick
`poolean-seed.json`. Then open a game from the **Games** tab, paste in its video URL, and start
clicking stats.

## Data schema (JSON)

```json
{
  "players": [{ "id": "player_abc", "name": "Jane Doe" }],
  "masterVideos": [{ "id": "master_abc", "name": "Aug 16 games", "fileName": "IMG_2764.MOV" }],
  "games": [
    {
      "id": "game_abc",
      "date": "2026-08-24",
      "notes": "",
      "videoUrl": "https://youtube.com/watch?v=...",
      "masterVideoId": null,
      "videoStart": 0,
      "videoEnd": null,
      "winner": null,
      "teamA": ["player_abc"],
      "teamB": ["player_xyz"],
      "stats": [
        { "playerId": "player_abc", "pts": 12, "oreb": 1, "dreb": 3, "ast": 3, "stl": 1, "blk": 0, "tov": 2, "pf": 1 }
      ],
      "scoringEvents": [
        { "id": "score_abc", "scorerId": "player_abc", "points": 2, "made": true, "assistId": "player_lmn", "defenderIds": ["player_xyz"], "blockerId": null, "turnoverEventId": null, "rebounderId": null, "shotLocation": { "x": 42.1, "y": 18.6 }, "videoTime": 187.3 },
        { "id": "score_def", "scorerId": "player_abc", "points": 3, "made": false, "assistId": null, "defenderIds": ["player_xyz", "player_qrs"], "blockerId": "player_xyz", "turnoverEventId": "tov_ghi", "rebounderId": null, "shotLocation": null, "videoTime": null },
        { "id": "score_jkl", "scorerId": "player_lmn", "points": 2, "made": false, "assistId": null, "defenderIds": [], "blockerId": null, "turnoverEventId": null, "rebounderId": "player_xyz", "shotLocation": null, "videoTime": null }
      ],
      "turnoverEvents": [
        { "id": "tov_abc", "playerId": "player_abc", "opponentId": "player_xyz", "stealEventId": "stl_abc", "missEventId": null, "videoTime": 302.0 },
        { "id": "tov_def", "playerId": "player_qrs", "opponentId": null, "stealEventId": null, "missEventId": null, "videoTime": null },
        { "id": "tov_ghi", "playerId": "player_abc", "opponentId": "player_xyz", "stealEventId": null, "missEventId": "score_def", "videoTime": null }
      ],
      "stealEvents": [
        { "id": "stl_abc", "playerId": "player_xyz", "opponentId": "player_abc", "videoTime": 302.0 }
      ],
      "foulEvents": [
        { "id": "pf_abc", "playerId": "player_abc", "opponentId": null, "videoTime": null }
      ],
      "matchups": [
        { "id": "matchup_abc", "defenderId": "player_abc", "offenderId": "player_xyz", "note": "Q1", "videoTime": 45.0 }
      ],
      "plays": [
        { "id": "play_abc", "type": "highlight", "start": 30, "end": 40, "playerId": "player_abc", "note": "nice dunk" }
      ]
    }
  ]
}
```

`winner` is `"A"`, `"B"`, or `null` — a historical result imported from elsewhere (e.g. the
original Poolean spreadsheet), used for W/L records *only* until `scoringEvents` has real shots
logged for that game, at which point the actual score takes over as the source of truth. Leave
it `null` for a game you're recording fresh; there's no need to set it by hand.

`masterVideoId`, if set, points to an entry in the top-level `masterVideos` array — a recording
shared across several games — and takes priority over `videoUrl` and any per-game local file for
that game. `videoStart` is that game's start time (in seconds) within the shared recording, and
`videoEnd` (seconds, or `null`) is its optional end time — `null` means "runs to the end of the
recording" rather than a real bound, which is the default until you set one (unlike `videoStart`,
which always has a value since playback needs somewhere to seek to on load). Neither field
affects playback beyond the initial seek-to-`videoStart` — there's no auto-pause at `videoEnd`,
it's just a marker, mainly useful for anyone later splitting the shared recording into individual
per-game clips (see `INTEGRATION.md`). Neither the entry in `masterVideos` nor a game's own local
video file carries the actual video data — both only ever hold an id; the real file lives in this
browser's IndexedDB and is never part of a JSON export.

Each `masterVideos` entry also has `fileName` — the original uploaded file's name (e.g.
`"IMG_2769.MOV"`), captured once at upload time and never edited after. It's deliberately
separate from `name`, which you're free to retype to something less specific ("Aug 10 games")
and lose the one thing that actually tells two recordings from the same night apart. If you're
matching an export's `masterVideoId` against a recording on a real backend and the id itself
doesn't resolve to anything there, `fileName` is what to fall back to.

`date` should be an ISO date (`"2026-07-05"`, what the date picker in the form produces) —
that's what the games list sorts by and what gets reformatted into a friendly display date. A
non-ISO string still works but won't sort or display nicely.

A game's score is derived as the sum of `pts` for the players listed in `teamA` / `teamB` (not
stored separately). Every field in `stats` — `pts`, `ast`, `blk`, `oreb`, `dreb`, `tov`, `stl`,
and `pf` — is derived, none of them stored directly: `pts`/`ast`/`blk`/`oreb`/`dreb` all come
from `scoringEvents`, the other three from `turnoverEvents`/`stealEvents`/`foulEvents` —
recomputed automatically by `recomputeDerivedStats()` in `app.js`, so don't hand-edit any of
these eight fields without also updating the matching event array to match.

Every field goal or free throw attempt is a `scoringEvents` entry, made or missed:
`points` is the attempted value (1 = free throw, 2 or 3 = field goal), and `made` distinguishes
the two — `made: false` means it's a miss and shouldn't count toward `pts`. Entries with no
`made` field at all are treated as made (they predate misses being tracked at all).
`assistId` is the one teammate who gets credit, or `null` for an unassisted make — only
meaningful when `made: true`; a miss can't be assisted, and the app never sets it on one.
`defenderIds` is an array — empty means no defender was responsible for that shot (an open
shot), and more than one entry means it was double-teamed; each tagged defender gets full credit
for the shot in their own stats, not a split share. Entries with a singular `defenderId` field
instead of `defenderIds` predate double-team support and mean the same thing as a one-element
array. `blockerId` is the one opponent who blocked the shot, or `null` — only meaningful when
`made: false` (a block is always a miss); that player's `blk` in `stats` is a count of shots
where they're the `blockerId`. `turnoverEventId` is set on a miss that went out of bounds — per
Poolean's actual rule, whoever last touched the ball loses possession, so an out-of-bounds miss
is a turnover for the shooter — and points at the auto-created `turnoverEvents` entry for it (see
below), the same way a steal auto-creates a linked turnover. `rebounderId` is the one player (from
*either* team) who grabbed a live-ball miss, or `null` — only ever set when `made: false` and
`turnoverEventId` is `null` (an out-of-bounds miss is a dead ball, never rebounded). Whether it
counts as `oreb` or `dreb` isn't stored — it's decided by comparing the rebounder's team to the
shooter's (`sameTeam()` in `app.js`): same team is an offensive rebound, the other team is
defensive. `shotLocation` is `{ x, y }` (each 0-100, percentages of the shot chart — `y: 0` at
the hoop, `y: 100` at the far wall, `x: 0`-`100` across the court's width) or `null` if it wasn't
marked; only ever offered (and only ever set) when `points` is 2 or 3, never on a free throw,
since a free throw has no location on the floor. It's purely informational — it doesn't drive
`points`, and the app never corrects a mismatch between the marked spot and the point value you
picked, it just flags one with a badge in the Shot Log. Shooting splits (FG/3PT/FT, with %),
eFG%, TS%, Game Score, Two-Way Score, and the defensive numbers (Pts Allowed, Opp FG%, Beaten,
Stops) shown in the Game Stats table and Leaderboard are all computed from this array plus
`stats` — see `shootingStats()`, `gameDefenseStats()`, `trueShootingPct()`, `effectiveFgPct()`,
`gameScore()`, `defensiveImpact()`, and `twoWayScore()` in `app.js`. None of these are stored as
separate fields. Also computed from `shotLocation`, only for 3PT attempts: the **3PT Line /
3PT Deep** split (`threePtBand()` in `app.js`, still returning `"arc"` internally — only the
displayed label changed, since a code rename wasn't worth the churn) — a shot's radial distance
from the hoop (`√((x-50)² + y²)`) against `THREE_PT_DEEP_THRESHOLD` (currently 80), used because
a shot right at the line and a much-longer heave are different shots that a single blended 3PT%
would average together. See the Stat Entry section above for the full rationale and the caveat about
this being a provisional threshold, not a settled one.

`turnoverEvents`, `stealEvents`, and `foulEvents` each hold one row per occurrence:
`playerId` did it, `opponentId` (nullable) is the one other player tagged as involved — who
forced/recovered the turnover, who it was stolen from, or who was fouled. Unlike shot
defenders, these are always a single opponent, never an array — a turnover/steal/foul only
ever involves one other player.

`videoTime` (seconds, or `null`) appears on `scoringEvents`, `turnoverEvents`, `stealEvents`,
`foulEvents`, and `matchups` — it's the video's playback position when that event was logged,
captured automatically from whatever `<video>` element is currently playing, backed up by
`TIMESTAMP_LEAD_SECONDS` (5 seconds) and clamped at 0 (see `currentPlaybackTime()` in `app.js`).
The lead time exists because you're always clicking a moment after the play actually happened —
without it, **Jump** would land you right on top of (or just after) the play instead of a beat
before it. It's `null` when no video was loaded, or the video is a YouTube/generic iframe embed
(this tool can't read an iframe's playback position). The auto-created turnover half of a steal
shares the exact same `videoTime` as its steal, since they're the same instant, not two
separately-captured moments.

Every `videoTime` recorded before this lead time existed gets backdated by the same 5 seconds
automatically, once, the first time a game loads after updating — flagged via
`game.timestampsBackdated` so it never runs twice on the same game and re-drift the times.

A steal is always also a turnover for whoever it was stolen from, so logging a steal creates
*both* records in one action: the `stealEvents` entry, and a `turnoverEvents` entry for the
victim with `opponentId` set to the stealer and `stealEventId` pointing back at the steal. A
turnover logged directly (not via a steal) has `stealEventId: null` and an optional or absent
`opponentId`. The two are kept in lockstep on removal — deleting either the steal or its linked
turnover deletes both, so they can never drift out of sync. `commitTaggedEvent()` and
`removeTaggedEvent()` in `app.js` are the single place this linking logic lives.

The same pattern covers a miss ruled out of bounds: marking one that way when logging the shot
creates a `turnoverEvents` entry with `missEventId` pointing back at the `scoringEvents` entry
(and that entry's `turnoverEventId` pointing the other way), `opponentId` set to the blocker if
there was one, else the lone defender if there was exactly one, else `null`. Deleting the shot
from the Shot Log also deletes its linked turnover; deleting the turnover from the Other Events
log just clears `turnoverEventId` back to `null` on the shot rather than deleting the shot
itself.

All ids are client-generated strings, stable across exports.
