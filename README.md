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

1. **Players** — add everyone in the league once. Anyone with a hand-transcribed scouting profile
   (see Balance Teams below) shows color-coded role tags next to their name (Scorer, Defender,
   Physical, Playmaker, Role Player) — height, build, and effort still feed the Balance Teams
   tiebreak but aren't surfaced as their own tag here (hover the tags for effort, height, build,
   and the original note in one tooltip). A row of the same five role chips above the roster
   filters it down to players carrying any of the roles picked (click one or more to narrow,
   click again to clear) — handy once the roster's long enough that scanning for "who are my
   defenders" isn't a one-glance thing anymore. **Edit Tags** opens an inline editor (height,
   build, effort, role checkboxes) right under that player's row — Save replaces their profile
   outright (not a partial merge, so it never mixes an edited role with a stale height), and
   **Reset to Default** clears a saved edit and falls back to the original hand-transcribed
   profile. Edits are saved per-player in `localStorage` and feed the same Balance Teams
   tiebreak everything else in this section describes.
2. **Games** — **Who's Coming?**, at the top, is a separate "who said they're showing up" plan
   for a date, not a game roster — pick a date, check off names, **Save RSVPs**. It doesn't
   create anything or touch stats by itself; once at least one game is logged for that date,
   whoever RSVP'd but never ended up on either team's roster that day counts as a miss, shown
   right in the recent-RSVP list below (Pending until a game exists for that date, then either
   "Everyone showed" or who was missed) and rolled up into that player's own **Flake %** on their
   Player Detail page. Saving again for a date already RSVP'd overwrites it rather than
   duplicating; saving with nobody checked deletes it. Then create a game (date, optional video
   URL, notes), then click it to open Stat Entry.
   Games are listed in chronological order (oldest first), each card headed by the actual player
   names on each side (not "Team A"/"Team B" — those labels only show for a freshly-created game
   with no roster set yet) and any game with a video attached (URL or local file) shows a 🎥
   badge, so you can spot at a glance which ones are ready to score. Once a game has real shots
   logged, its card also gets a 🔥/👎 pair — the best and worst individual performance in that
   specific game by Two-Way score, the same number Best & Worst Individual Games on the
   Leaderboard ranks by, just scoped to this one game instead of pooled across the season (skipped
   entirely for an unreviewed game, or one with only a single player on either side, since
   "best/worst" isn't meaningful yet). A game with video but nothing logged yet also gets a 📝
   **Needs Review** badge, and the count at the top of the list ("📝 N games with video still need
   review") tracks your backlog across
   all of them, independent of whatever the filter box below is currently narrowed to — a game
   with no video at all doesn't count toward this, since there's nothing to review yet. Once the
   list gets long, use the filter box to narrow down by date, notes, or any rostered player's
   name. **Advanced Filters**, right next to it, opens a panel for more specific lookups, additive
   to the text box (both apply together): a **Players** chip picker restricted to games where
   every checked player was actually in it, with a **Team** dropdown that only matters once 2+ are
   checked — "On the same team" vs. "On opposing teams" vs. "Doesn't matter" (just "all of them
   played, regardless of side"); a **Date range** (from/to); and a **Stat line** — pick a player, a
   box-score field (PTS through Two-Way), a comparison (≥/≤/=), and a value, to find something
   like "every game Ben scored 15+" without paging through the list by hand. Reads off the same
   per-game numbers Game Stats itself shows, computed fresh each time, not a stored/cached value.
   **Clear Filters** resets the whole panel (and the text box) in one click. Right above the list,
   **Balance Teams** turns picking fair sides into a click instead of
   eyeballing a roster: check off whoever's showing up, set a team size (defaults to 3), and
   **Generate Balanced Teams** returns up to 5 different splits, ranked primarily by how close
   each team's *average* season Two-Way/20 is to the others (more on the secondary factors below).
   Team count is whichever integer is closest to
   attendees ÷ team size, at least 2 — 7 people at a team size of 3 rounds to 2 teams (4-and-3),
   not 3 teams with one running short. The search is randomized (one seeded "snake draft" split
   plus 300 randomized attempts, deduplicated and sorted by spread), so **Generate** again turns
   up a different shortlist rather than the same one every time. For a straight 2-team split,
   **Use These Teams → Create Game** creates a real game with that roster pre-filled, using
   whatever date is set in Create Game above — for 3+ teams, this is a planning read only,
   nothing gets created for you automatically. This doesn't touch your data until you click that
   button; picking attendees and generating splits is throwaway, not saved anywhere. A player
   with no dashboard stats logged doesn't just default to a flat, misleadingly-neutral 0.0 — if
   they've got a real season-average power-ranking percentile (from `poolean_player_profiles.xlsx`,
   hand-imported into `PLAYER_REPUTATION_DATA` in `app.js`), that's converted into a Two-Way/20-
   equivalent estimate instead, and the attendee picker marks them with a **\*** (hover a chip for
   the exact number and source). Truly no-data players (never logged a game *or* a real-life
   party) still fall back to a neutral 0.0.

   Height, build, effort, and role — originally hand-transcribed from the same spreadsheet's
   "Player Profiles" sheet into `PLAYER_PHYSICAL_DATA` at Ben's explicit request, now editable
   straight from the **Players** tab (see "Editing player tags" below) — factor in too, but
   strictly as a tiebreaker: **quality (Two-Way/20, real or estimated) always decides first.**
   Physical/role only gets to choose between options that are already close on quality, and
   "close" itself stretches with how much of the group is a reputation-based guess rather than a
   real number — the less trustworthy the quality spread is (an all-reputation-estimated group),
   the more say physical/role gets, on the theory that hundredths-of-a-point differences between
   guesses aren't worth treating as settled. Four things feed the tiebreak, all weighted equally
   (0.75x each) — role, height, build, and effort — how evenly each player's role tag(s)
   (Scorer / Defender / Physical / Playmaker / Role Player) spread across teams, so one side
   doesn't end up with every tagged Defender and the other with none; a small number of players
   carry two roles (e.g. a lockdown defender who also facilitates on offense), counting toward
   both when this is tallied; how far apart each team's *average* height lands; how far apart
   each team's *average* build lands (skinny through very muscular); and how far apart each
   team's *average* effort level lands (Low through Very High, from the sheet's own "Effort"
   column — the one factor that deliberately never shows as its own tag pill, so it balances a
   team's showing-up-and-trying-hard mix without turning into a public "this guy doesn't try"
   label; still visible on hover and in the Edit Tags editor) — all four carry the same,
   deliberately light weight, a small nudge each rather than a deciding factor. One exception
   sits a level
   above the rest of the tiebreak, closer to a real
   guideline than a nice-to-have: every team should have someone taller than today's
   attendee-group's own average height, since a team with nobody above that line is a real
   disadvantage in this league. It's still not absolute — a split that's clearly better-balanced
   on quality can still win even if it misses the height guideline — but among options that are
   already tied on quality, one that clears the bar always beats one that doesn't. Each team card
   in the results shows its own average height, average build, and role mix (as the same
   color-coded tags as the Players tab, not plain text) so this reasoning is visible, not a black
   box.

   Real chemistry factors in too, but unlike height/build/role, it's folded directly into each
   team's quality average rather than sitting outside it as a tiebreaker — this is the one place
   past games actually move the primary ranking, not just settle close calls. For every pair of
   attendees who've actually shared a team before, their real "with this teammate vs. without"
   Two-Way/20 lift (the same number Player Detail's own Teammate Synergy panel shows) nudges that
   team's average up or down, dampened by how many games they've actually shared (a single shared
   game counts for less than three or more) — a pair who's never played together contributes
   nothing, not a penalty for being untested. It's asymmetric on purpose: player A's lift from
   playing with B is a different number from B's lift from playing with A, since those are
   different facts about different players' own games. A team card shows its own **Chemistry**
   line whenever the adjustment is large enough to matter, alongside the pairing's own shared game
   count (e.g. "min 2 games together") so it's clear at a glance how settled that number actually
   is, rather than treating a single shared game the same as ten.

   A pairing's actual **win rate** together factors in the same way — folded into the primary
   average, not a tiebreaker. Unlike Chemistry, this one's about whether *teams* built around
   these two have actually won, not how either player performed individually, so it's symmetric
   (Ben and Zach's record together is one shared fact, not two) rather than directional. Converted
   to a Two-Way/20-scale adjustment with the same formula the reputation-percentile estimate
   already uses (10 percentage points of win rate ≈ 1 point of Two-Way/20), and dampened by games
   played together the same way Chemistry is — a pair's record over just one or two shared games
   isn't settled yet. Shown as its own **Past record** line, right under Chemistry, with the same
   game-count note, whenever it's large enough to matter.

   Chemistry and win rate don't just re-rank whatever candidates come out of the generator —
   each of the top 30 candidates by quality+chemistry+win-rate spread gets hill-climbed
   afterward, trying random single-player swaps between two of its own teams and keeping any swap
   that lowers that same spread. Without this step, a split that would've been genuinely great on
   chemistry or past record could go ungenerated entirely, since the initial randomized search
   only ever optimizes individual quality while building a candidate; this refinement gives real
   history from actual games played a chance to shape which splits get proposed, not just decide
   between whatever showed up. It never touches height/build/role's own physical score — that
   stays a pure tiebreak applied after refinement, same as before.

   For any 2-team split, **Preview Matchups** expands real head-to-head history between the two
   rosters about to face each other — every scorer/defender pair from either side with real
   logged shots between them, sorted by attempts, both directions (each side's shooters against
   the other's defenders). Reuses the same data as the league-wide Head-to-Head Matchup Grid
   further down, just scoped to these specific players instead of the whole roster — a pairing
   with no history yet just says so rather than showing a grid of empty cells.
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
     and a **▶ Jump** button in its table (Shot Log, Other Events, Defensive Matchups, and the
     Highlight/Lowlight Reel) that seeks the video right back to that instant and scrolls it into
     view, so you can re-watch any specific play later without hunting for it — including
     scrolling back up to find the player itself if you'd been scrolled down reading one of these
     tables. This needs a local video file or a direct video link loaded (the ones that
     play as an actual `<video>` element) — a YouTube embed can't be read for its playback
     position, so events logged against one just won't have a time. Click any column header on
     these four tables to sort by it — a **↺ Chronological** button next to each puts it back
     the way it opened (most-recently-logged-first for the Shot Log, actual video-time order for
     the other three), since sorting these away from their natural order and then losing track of
     how to get back would make logging a game live genuinely harder, not easier.
   - The **Game Stats** table (between the box score and the Shot Log) rolls all of this up per
     player for the game: FG/3PT/FT splits with %, **eFG%** (FG% weighted so 3s count extra),
     **TS%** (true shooting — overall scoring efficiency across FGs and FTs combined),
     assist-to-turnover ratio, and defensive numbers derived from who was tagged as the defender
     in the Shot Log — **Pts Allowed** and **Beaten** (points scored, and times scored on, while
     they were the defender on a *make*), **Opp FG%** (shooting % of everyone they were tagged
     defending, make or miss — a real "shooting percentage allowed"), and **Stops** (times they
     were the defender on a *miss*). **Off Rating** rolls the offensive half of the box score into
     one "how good was this game" number — PTS, shooting efficiency, rebounds, assists, TOV, and
     fouls — adapted from the standard basketball Game Score formula, with its two defensive terms
     (STL and BLK) pulled out. Those two terms live in **Def Rating** instead, folded in with the
     rest of the defensive numbers: STL, plus BLK (with one exception below), plus
     `Stops − Beaten − 0.4×Pts Allowed` — weighting a Stop the same as STL (1.0), Beaten as its
     direct negative counterpart, and Pts Allowed lightly (0.4) just so a 3-point beat scores worse
     than a 2-point beat without double-penalizing the same possession the Beaten count already
     covers. Opp FG% isn't its own term in the formula since it's just Beaten ÷ (Beaten + Stops)
     — a separate term would double-count the same information. Named after the NBA stat but not
     the same formula: real Defensive Rating is points allowed per 100 possessions, and this tool
     doesn't track possessions, so it's normalized per 20 combined points like every other rate
     here instead. A player never tagged as a defender, with no steals or blocks, has a Def Rating
     of 0, not a penalty — conservative tagging (only tag a defender when it's genuinely clear)
     should never hurt a player's Two-Way Score.
     The BLK exception: a block only adds to Def Rating when it *isn't* already one of this
     player's own tagged Stops on that same shot — the unusual case, since a shot-blocker is
     almost always also that shot's tagged on-ball defender. When it is (the normal case), the
     Stops term above already covers that possession at full weight (1.0); adding BLK on top of
     it would credit the same defensive possession twice. This isn't just a relabeling — it's a
     real fix: the old combined "GmSc + Def Impact" formula gave a blocked-and-tagged shot credit
     in *both* places at once (0.7 from GmSc's BLK term, 1.0 from Def Impact's Stops term, 1.7
     total for one possession), which is exactly what splitting Off Rating out from Def Rating
     closed. **Two-Way** is Off Rating plus Def Rating. The season **Leaderboard** shows every one
     of these as a rate per 20 combined points across all games, not a raw season total — see
     `offensiveRating()`/`defensiveRating()`/`twoWayScore()` in `app.js`. STL and BLK are shown as
     recorded — they also feed Def Rating — and their sum ("Stocks") isn't repeated as its own
     column in either table since it's just those two added together, but it is in the CSV
     exports. Click any column header to sort by it (defaults
     to PTS, highest first) — this is one game's own box score, not a season, so it's every
     player who was on either roster for this specific game, nothing averaged.
   - Add defensive matchup entries (who guarded who, with an optional note like "Q1") as they change.
     This is separate from "scored on" — matchups are about who was generally guarding who,
     while the scoring log is specifically about who got beaten on each made basket.
   - **Highlight / Lowlight Reel** — while the video plays, click 🔥 **Mark Highlight** or
     👎 **Mark Lowlight** to grab a ~10 second clip centered on the current playback time (5s
     before to 5s after). Each marked clip shows up in the table below, where you can nudge its
     start/end times, tag which player it's about, add a note, jump the video back to it, or
     remove it. This only works with a local video file or a direct video link (the ones that
     load as an actual `<video>` element) — a YouTube embed can't be read for its current time.
     **🎬 Combine Clips Into One Video**, below the table, plays every clip in this game's reel
     back-to-back and records the playback live in the browser (via `MediaRecorder`), downloading
     one combined `.webm` file when it's done — entirely in-browser, no server and no new
     dependency, matching everything else in this tool, but genuinely different from every other
     feature here in one real way: it's live video processing, not computed analysis, so it runs
     in *real time* (a 5-minute combined reel takes about 5 minutes to produce) and needs the tab
     to stay open, foregrounded, and actually playing the whole time — backgrounding it can stall
     or degrade the recording. A **Cancel** button appears while it's running. Clips always
     combine in chronological (video-time) order regardless of how the Reel table above happens
     to be sorted at the moment.
4. **Leaderboard** — every counting stat as a season-wide *rate per 20 combined points scored in
   the game*, not a raw total or a per-game average, plus **W-L record and win %** per player (a
   game counts as a win/loss/tie for everyone on the winning/losing/tied team, since teams
   reshuffle every game — there's no team standings, just individual record). Only a game with
   real shots logged *and equal team sizes* counts toward a player's row at all — one that's just
   been rostered but not reviewed yet doesn't drag their numbers toward 0, a player with no such
   games doesn't clutter the table with a row of dashes, and a 3-on-2 (or any other lopsided
   roster split) doesn't get pooled into a rate math that assumes every game was a fair fight.
   Imbalanced games show a **⚖️ 2v3**-style badge on their Games list card so they're easy to spot,
   and stay fully visible everywhere that isn't a computed comparison — Game Log, Stat Entry, CSV
   exports, Highlights & Lowlights all still show them as real history. **Include Imbalanced
   Games**, next to the advanced-columns toggle above the table, brings them back into every
   rate/award/chart if you'd rather see the old numbers (remembers your choice on reload, same as
   the advanced-columns toggle). Right after PTS/20 sits **Shot%** — not a per-20 rate
   like its neighbors, but a season-long share: what percentage of their own *team's* total field
   goal attempts were theirs, across the games they played (their FGA ÷ their team's FGA in those
   same games — teammates included in the denominator, opponents' shots never counted). Free
   throws aren't field goal attempts, so a player who draws a lot of fouls but shoots little from
   the field won't show an inflated Shot% from that. This is deliberately about a team's own shot
   diet, not the league's — the meaningful comparison for "who's actually taking the shots on a
   given night" is against the three or four other people on the floor with them, not the whole
   roster. Right next to it, **AST%** is the same idea for playmaking: what percentage of their
   own team's total assists were theirs, across the games they played (their AST ÷ their team's
   AST in those same games) — same season-long share, not a per-20 rate, same team-scoped
   denominator rather than the league's. **OREB%** and **DREB%**, right after AST%, are the real
   Total Rebound %-style version rather than a Shot%/AST%-style team share — a rebound is
   contested between *both* teams on the floor, so the denominator is every rebound actually
   available on that category of miss: OREB% is their OREB ÷ (their team's OREB + the opponent's
   DREB on their team's own misses), DREB% is their DREB ÷ (their team's DREB + the opponent's
   OREB on the opponent's misses). The real version of this stat normally needs minutes played, to
   scope "available" down to while a player was actually on the floor — this tool doesn't track
   minutes, but Poolean has no substitutions, so a rostered player is on the floor for the entire
   game and that term drops out on its own. **TRB%**, right after DREB%, is the two combined:
   OREB plus DREB against OREB%'s and DREB%'s two pools added together — the overall "how much of
   the available boards did this player grab" read. **TOV%** is a different shape entirely — not
   a share of the team's turnovers (a turnover isn't a shared resource the way a shot, assist, or
   rebound is), but a share of this player's *own* scoring opportunities: `TOV ÷ (FGA + 0.44×FTA
   + TOV)`, the same free-throw-trip scaling TS% uses. Of the times this player had the ball in a
   position to score or give it away, how often it was the latter. All six of these "%" columns
   (Shot%/AST%/OREB%/DREB%/TRB%/TOV%) are hidden by default — the table's pushing 35 columns
   without them, and these are the newest, most niche additions. **Show Advanced % Columns**,
   above the table, reveals them (and remembers your choice on reload); they're in the Leaderboard
   CSV export regardless of whether they're shown on screen. If the table happens to be sorted by
   one of them when you hide them again, sort falls back to PTS/20 rather than leaving the table
   sorted by a column you can no longer see or click. **Click any column header to sort by it** (click again to flip
   between highest-first and lowest-first) — hover a header for a sentence on what that column
   means, since 25+ columns (more with the advanced ones shown) is a lot to hold in your head
   while staring at a number. The last
   column, **Last 5**, is a quick "how are they trending lately" read: Off Rating/20 over just their
   last 5 games with real shots logged (fewer if they haven't played 5 yet), with a ▲/▼ showing
   whether that's above or below their season Off Rating/20 (within ±0.5 counts as flat, shown as ●
   rather than a dash, since a dash next to a number reads as a minus sign).

   Right below the main table, **Past Seasons (League)** is the league-wide counterpart to each
   player's own Past Seasons panel on Player Detail — pick a closed season from the dropdown and
   see full standings (GP, record, Off/Def/Two-Way Rating) for that season alone, computed live
   off its own archived games. This is a different thing from the **Include Past Seasons** toggle
   above: that toggle blends past seasons *into* the live current-season totals; this instead
   shows one past season completely on its own, exactly as it played out, regardless of the
   toggle's state. Click a name to jump to their Player Detail page. Empty and disabled until at
   least one season's been closed (Export → Data Management → Start New Season).

   Right below that, **Consistency** ranks players by the standard deviation of their
   own per-game Two-Way/20 (same numbers the Two-Way Trend chart on Player Detail plots) — lower
   means steadier output night to night, not necessarily better output, so a reliably-average
   player ranks as more consistent than a boom-or-bust one whose season average lands the same.
   Needs at least 2 qualifying games (a single game has no variance to measure). This is one of
   the real, real-voted Summer 2026 **MVP** award's own criteria (impact on winning, consistency,
   attendance, leadership, sportsmanship, making teammates better — see Awards vs. Stats further
   down, where season-long **Two-Way total** is already the closest tracked comparison to that
   award, impact and attendance-via-volume both baked in) — kept as its own separate ranking
   rather than folded into a made-up combined score, since "consistent" and "valuable overall"
   are different questions worth answering separately. Click a name to jump to their Player
   Detail page.

   Right below that, **Player Comparison** picks up where a 34-column table stops being
   readable for "just tell me how these two stack up": two dropdowns, and every column from the
   table above (all 31 of them, including the six advanced ones regardless of whether they're
   currently shown) laid out as rows instead, one player's value next to the other's. Green marks
   whichever value is better for a given stat where "better" has an unambiguous direction — lower
   for TOV/PF/Pts Allowed/Opp FG%/Beaten/TOV%, higher for everything else with a real quality
   read — and GP plus the shot-share percentages (Shot%/AST%/OREB%/DREB%/TRB%) are left
   uncolored on purpose, since a bigger share of the team's shots or assists is a role a player's
   settled into, not inherently better play. Not to be confused with the **Comparison Scatters**
   further down (Two-Way Quadrant, Volume vs. Efficiency) — those plot the whole roster at once
   on two axes; this is a focused, all-stats side-by-side for exactly two named players.

   Everything below this main table is grouped into five loose sections, top to bottom: season
   **Overview** (Awards vs. Stats, Power Ranking vs. Performance), **Comparison Scatters**
   (Two-Way Quadrant, Volume vs. Efficiency), **Shot Location & Efficiency** (the heatmap through
   League TS% Over Time), **Matchups & Chemistry** (the pairing grids and Assist Connections), and
   **Situational & Moments** (Out-of-Bounds through the two highlight reels at the very bottom).
   The grouping is marked with HTML comments in `index.html` if you're looking for a specific
   panel in the source.
   Below the table, **Awards vs. Stats** lines up Summer 2026's voted awards (MVP, DPOY, Clutch,
   Most Improved, Best Teammate, First/Second Team, Best/Worst Duo — from that season's closed
   ballot, a fixed historical record, not something this tool derives) against whichever tracked
   stat is the closest comparison for that award: **MVP** compares season-long total Two-Way
   Score (not a per-20 rate) — durability and total contribution should count for MVP, not just
   rate over however many games someone happened to play. **Best Player**, **First/Second Team**,
   and the duo awards compare Two-Way/20 rank instead; **DPOY** compares Def Rating/20 rank;
   **Most Improved** compares the Last 5 trend (Two-Way/20, same mechanism as the Leaderboard's
   own Last 5 column, just using Two-Way instead of Off Rating here); **Best Teammate** compares the
   average Two-Way/20 lift that player gives their actual teammates (each teammate's own
   With/Without split, same source as the Teammate Synergy panel on Player Detail) — a duo award
   also shows how many assists actually happened between that pair. **Clutch** compares
   **Close-Game Shooting** (see below) — TS% scoped to attempts from games decided by 5 points
   or fewer — rather than **Game-Winning Buckets**, which sounds like the obvious match but
   isn't: in a race-to-target format the game literally ends on the winning basket, so GWB tracks
   "who tends to close games out" more than it tracks performance under real pressure, and grows
   by exactly one per decided game regardless of how the rest of that game went. Close-Game
   Shooting is the sharper read for what Clutch is actually asking. Every number here is computed live from whatever games are
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
   Right below that, **Power Ranking vs. Performance** does the same kind of comparison, but
   per-night instead of per-season: the real Poolean site computes its own power ranking for
   every party (rank 1 = best that night, a field-size-normalized percentile — 100 for first,
   0 for last), and that's a frozen historical record here too, not something this tool derives.
   Paired against that same player's actual Two-Way/20 in just the games logged for that
   specific date — a night only shows up here at all once at least one of its games has been
   reviewed. The other 10 real parties predate any footage existing, so they never will; a night
   with footage that just hasn't been reviewed yet is left out too, rather than showing a table
   of nothing but dashes. A player who didn't have a game logged for that particular night still
   shows "—", not a zero — that's a gap in what's been reviewed, not a real 0.0 performance.
   Right below that, a **Two-Way Quadrant** chart plots one dot per player: Off Rating/20 (offense) on
   the x-axis, Defensive Rating/20 on the y-axis — the two halves of Two-Way Score, kept separate
   instead of pre-summed, so "who's good" splits into "good at what." The quadrant lines cross at
   zero on each axis rather than at this roster's own median, since zero is already the meaningful
   boundary each stat uses on its own — a median split would just be an arbitrary line drawn
   through wherever this particular group happens to cluster. Each player gets their own distinct
   dot color (an 8-color colorblind-safe palette, cycling if there are more players than colors)
   instead of one uniform accent color — with a real roster this matters, since a wall of
   identically-colored dots is only distinguishable by tiny, easily-overlapping text labels.
   Right below that, **Volume vs. Efficiency** is a separate scatter, offense only — pure shot
   volume (FGA/20) on the x-axis against season TS% on the y-axis, so a high-volume/low-efficiency
   player and a low-volume/high-efficiency player show up as mirror opposites directly instead of
   requiring someone to cross-reference the FGA and TS% columns on the main table by hand.
   Below that, **Game-Winning Buckets** counts, per player, how many times their shot actually
   closed out a game their team won — the real game-ending basket in Poolean's race-to-a-target
   format. Credited only when *every* made shot in that game has a real video timestamp — a
   single untimed shot could have happened at any point, early or late, so a partial set of
   timestamps can't reliably say which shot was really last. That's a real limitation, not a
   preference: a game logged without timestamps (or with just a few) will never contribute here,
   even if you're certain from memory which shot actually won it. A season count, not a rate,
   since a rate would round a rare, memorable thing down to an unreadable decimal.
   Right below that, **Close-Game Shooting** is the tracked stat behind the Clutch comparison
   above, not Game-Winning Buckets — GWB is explicitly non-scarce by construction (the last
   basket of every decided game belongs to the winning team, full stop), so it measures "who
   tends to close games out," not performance under real pressure. This one is
   plain TS%, but scoped to attempts from games that actually finished close: decided by 5 points
   or fewer (`CLUTCH_MARGIN_THRESHOLD` in `app.js` — a starting guess against Poolean's 16/21-point
   targets, not a value backed by real season margin data yet, same provisional-constant treatment
   as every other threshold on this page). Tied games count here even though a tie has no "winning
   shot" for GWB to credit — a tie is the closest a game can possibly finish. Click any column
   header to sort.
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
   (see **Export → Backfill Shot Locations** to fill in the rest). Right below that, a
   **Head-to-Head Matchup Grid** puts every scorer down one axis and every defender across the
   other — the league-wide version of the per-player Head-to-Head tables on Player Detail, which
   only ever show one player's matchups at a time and so hide any strong or weak pairing between
   two *other* players until someone happens to look. Each cell is that scorer's FG% against that
   specific defender, colored the same red-low/green-high way as the heatmap, opacity ramping up
   with sample size so a 1-for-1 cell reads as less certain than a well-sampled one. A blank cell
   means that exact pairing has never been tagged. Rows and columns are both sorted by total
   attempts, most data first. A double-teamed shot counts once per tagged defender, same rule the
   Head-to-Head tables already use — and like those tables, this isn't filtered to field goals
   only. Right below that, **Wide-Open Shooting** is the opposite cut: every field goal with
   *no* tagged defender at all, not who beat whom but how a player shoots when nobody's tagged
   as guarding them. Free throws are excluded entirely — they're uncontested by rule, not by
   circumstance, so counting them would trivially inflate the numbers with a shot type that was
   never a real read on defensive pressure. Share of FGA (how much of a player's own shot diet
   was untagged) sits next to TS%, since a high TS% off 2 wide-open looks means something very
   different than the same number off 20. Click any column header to sort. Below that, **Assist
   Connections** lists every passer-to-scorer pairing, league-wide, with how many times each has
   happened — directional (Alice assisting Bob is a separate row from Bob assisting Alice) — a
   straight readout of the Shot Log's assist tags, sorted by count. Right below that, a
   **Teammate Lift Matrix** does for Average Teammate Lift (the Best Teammate award's stat, see
   above) what the Matchup Grid does for Head-to-Head: turns one aggregated number per player into
   a full grid of every specific pairing. Row player on the team, column player's own Two-Way/20
   change as a result — green for a boost, red for a drag, opacity tracking how large that swing
   is relative to the biggest one on the grid. A blank cell means that pair hasn't logged games
   both with and without each other yet. **This grid is not symmetric** — row Alice / column Bob
   ("does Alice help Bob") and row Bob / column Alice ("does Bob help Alice") are two different
   facts about two different people's own games, not mirror images of the same number, so don't
   expect it to look symmetric across the diagonal the way a simple relationship count would.
   (There's deliberately no
   win/loss duo table here — the real Poolean site already tracks that.) Right after it,
   **Teammate Context** puts Player Detail's Teammate Quality, Offensive/Defensive Matchup
   Difficulty, and Assisted By season averages side by side for every player at once — Off
   Rating/20, Teammate Quality, Off Matchup Difficulty, Def Matchup Difficulty, Assisted%, and Avg
   Assister Quality in one sortable table, built to catch a specific pattern across the whole
   roster without clicking into each player one at a time: someone whose own Off Rating/20 leans
   on strong teammates (high Teammate Quality), easy defenders to shoot over (low Off Matchup
   Difficulty), and light defensive assignments (low Def Matchup Difficulty) is a different case
   from someone posting the same number on their own. Season summaries only, straight off the
   same compute functions Player Detail uses — see the Player Detail section below for the full
   formulas and the game-by-game trend charts. Below that, **Shot
   Distance** splits every field goal further by how far it actually was from the hoop, on both
   sides of the 3pt line: **Close** and **Midrange** split the 2PT zone at its midpoint;
   **Line** (a normal, makeable three right at the line — "Line" not "Arc," since Poolean's
   three is straight, not curved) and **Deep** (a much lower-percentage near-pool-length heave)
   split the 3PT zone the same way the plain 3PT% column on the table above blends together.
   Both splits are radial distance from the hoop (`√((x-50)² + y²)` in the shot chart's own
   0-100 coordinates, not real feet) against a single adjustable constant each
   (`CLOSE_RANGE_THRESHOLD` at 30 for the 2PT split, `THREE_PT_DEEP_THRESHOLD` at 80 for the 3PT
   one, both in `app.js`) — the 3PT threshold drawn from an early season sample, the 2PT one a
   rougher starting guess with no shot volume behind it yet, so treat it as even more
   provisional than the 3PT one. Only field goals with a marked shot location count (see
   **Export → Backfill Shot Locations** to fill in the rest). Each zone column shows FG% (click
   to sort) with that zone's share of the player's own attempts printed underneath it — how well
   they shoot from there, and how much they lean on it, in one cell rather than two separate
   panels (this table used to be split into "Shot Distance" and "Shot Selection"; they were
   merged since both were the same per-player, same-four-zone breakdown, just two different
   numbers). The **Mix** column at the end is the same shot-selection breakdown as a compact
   visual instead of text — one stacked bar per player, colors tracking typical shot quality
   (green close, amber midrange, teal line, red deep, same association as the heatmaps' FG%
   coloring) — not itself sortable, since a bar has no single number to sort by.
   Below that, **League TS% Over Time** pools True Shooting % across every player, one point per
   date with at least one reviewed game — a single league-wide efficiency line rather than a
   per-player stat, meant for watching the whole league drift over a season or for checking whether
   some future rule change actually moved the needle.
   Right below that, **TS% by Shot Distance** is a plain 4-bar chart of the same Close/Midrange/
   Line/Deep split as the Shot Distance table above, meant to make a "shooting gets worse with
   distance" story (or wherever it actually breaks down) land in one glance instead of requiring
   someone to read that table and compare percentages in their head. Free throws have no shot
   location, so unlike the line chart just above it, this one excludes them entirely — each bar is
   just that zone's own points scored per attempt in that zone. Worth knowing: TS% for a single
   zone isn't capped at 100% the way whole-game TS% effectively is in practice — a small,
   hot-from-three sample can clear it (one make on one three-point attempt is 3 points on 1 FGA,
   which is 150% by the formula), so don't read a bar taller than the others as a data error.
   Below that, **Out-of-Bounds Misses**
   shows how often a player's own missed shot ends up out of bounds — per Poolean's actual rule,
   whoever last touched the ball loses possession, so this is really "how often does the ball
   leave their hands for good on a miss," not a shooting-accuracy stat. Misses are the
   denominator, not total shots, since a make can never go out of bounds; a league-wide line
   above the table gives the same rate across everyone, for context. Click any column header
   here to sort by it too. Below that, **Second-Chance Conversion** answers a sharper question
   than "who grabs offensive rebounds" — of those OREBs, how many actually turned into points?
   An OREB counts as converted when, within 20 seconds of the missed shot's own video timestamp,
   either that rebounder scored themselves or someone else scored with them credited as the
   assist — either path counts once, a kick-out three is worth the same as a putback. Both the
   miss and the follow-up score need a real video timestamp to be checked; an OREB logged
   without one still counts toward the OREB total but can't be evaluated for conversion, and a
   note above the table says how many were skipped that way. The 20-second window is a single
   adjustable constant (`SECOND_CHANCE_WINDOW_SECONDS` in `app.js`), same pattern as the
   shot-distance thresholds — not a UI setting. This panel runs the exact same algorithm as
   `scripts/second-chance-analysis.js`, a standalone read-only script that does the same
   computation against an exported JSON file instead of whatever's loaded in this browser (handy
   for checking someone else's export, or a season that isn't the one currently loaded here) —
   see that file's own header comment for how to run it. Below that, and after Game-Winning
   Buckets, **Best & Worst Individual Games** ranks every player-game by that single game's own
   Two-Way score (Off Rating + Defensive Rating) — deliberately not a per-20 rate or a season
   total, since the rest of the Leaderboard normalizes everything for fair comparison, which
   averages away exactly what this panel exists to surface: a specific night's story, buried
   otherwise inside that game's own box score. Every player on either roster in a reviewed game
   gets a row, even a quiet one. On a thin season the two lists (Best and Worst) are capped so
   they never end up showing the same handful of games twice, just reversed.
   The Leaderboard tab's very last panel, **Highlights & Lowlights (League)**, is every tagged
   clip from every player and game pooled into one list, most recent first — the league-wide
   version of the per-player Highlights & Lowlights table on Player Detail (see below), which
   only ever shows one player's clips at a time. Same source (the Highlight/Lowlight Reel table
   in Stat Entry), just with a Player column added and nothing scoped to one person.
   **🎬 Combine All Clips Into One Video**, below that table, is the league-wide version of the
   per-game combine-video feature in Stat Entry (see above) — same real-time, in-browser
   `MediaRecorder` approach, extended across every game instead of just the one currently open. It
   loads each game's video in turn (oldest game first) into its own small preview player, visible
   while it's running so there's some confirmation something's actually happening. A game whose
   video is a YouTube embed or a generic iframe link can't be captured this way and gets skipped —
   the final summary says how many clips and games that affected, if any. This can take a genuinely
   long time for a full season's worth of clips (it's still real-time, one clip's own duration at
   a time, now just across every game instead of one), and needs the tab to stay open and
   foregrounded the whole way through — a **Cancel** button is there if you need to stop, though
   cancelling discards the whole recording rather than downloading whatever got through, since a
   silently-truncated "combined" video seemed more likely to be mistaken for the real thing than a
   clean "nothing downloaded."
   Click a player's name to
   open their **Player Detail** page, which is grouped the same loose way: **Past Seasons** and
   **Flake %** (see Season Archiving and Who's Coming? above) at the top, season **Overview**
   (Two-Way Trend, Game Log), **Offense Detail** (Shot Chart, Shot Heatmap, Head-to-Head — As
   Scorer), **Defense Detail** (Defensive Heatmap, Head-to-Head — As Defender), **Team Context**
   (Teammate Synergy, Teammate Quality, Assisted By, Offensive Matchup Difficulty, Defensive
   Matchup Difficulty), and **Media**
   (Highlights & Lowlights) at the very bottom:
   - **Two-Way Trend** — Two-Way/20 for every reviewed game this player's played, in chronological
     order, with a dashed season-average reference line. This is the line-graph version of the
     "Last 5: X vs. season Y" text the Leaderboard's Last 5 column already shows (and what the
     Most Improved comparison in Awards vs. Stats is built on) — seeing whether the recent points
     sit above or below the dashed line is instantly legible in a way two numbers to compare by
     hand aren't.
   - **Shot Chart** — every marked field goal this player has taken, plotted at its actual spot
     on the court, green for a make and red for a miss (semi-transparent, so overlapping shots
     read as a visibly denser cluster instead of just stacking invisibly). This shows the
     individual-shot pattern the zone-bucketed heatmap below it necessarily smooths over — a
     lean to one side of the court, a specific gap, a real cluster — none of which a table of
     zone percentages shows directly.
   - **Game Log** — every game they've played, default most recent first (click any column
     header to sort by something else instead), with the same full stat line (shooting splits,
     eFG%/TS%, defensive numbers, Off Rating, Two-Way) as the Game Stats table, plus that game's
     W/L/T result. Unlike the Leaderboard, this is per-game actuals, not averaged — one row per
     game, exactly what happened in it. The literal data behind the Two-Way Trend chart above it.
   - **Shot Heatmap** — the same court grid as the Shot Chart, scoped to just this player's
     marked field goals across every game.
   - **Head-to-Head — As Scorer** — their shooting *against* each defender who's guarded them,
     across the season, sortable, defaulting to most-guarded-by first. This only reflects shots
     where a defender was actually tagged — untagged ("No defender") shots don't attribute to
     anyone.
   - **Defensive Heatmap** — the same grid again, but keyed on every shot this player was tagged
     *defending* instead of shots they took, colored by opponent FG% allowed and inverted (low is
     good defense here, so it's green, not red). This is what actually answers whether a player's
     overall Opp FG% holds up at every distance or collapses somewhere specific — a single season
     number on its own can't say that. A double-teamed shot counts toward every tagged defender,
     same rule the Head-to-Head — As Defender table below uses.
   - **Head-to-Head — As Defender** — the shooting they've *allowed* to each scorer they've
     defended, same tagging caveat and sortability as As Scorer above.
   - **Teammate Synergy (With/Without)** — for each teammate this player has shared a team with,
     this player's *own* Off Rating/20 and Two-Way/20 in games **with** that teammate on their side vs.
     games **without** them (opposing team, or not playing that game). This is about whether this
     player's own output actually changes with a given teammate around — not a shared win/loss
     record — so a teammate they've always played with shows "—" on the without side rather than
     a misleading 0.0, and a small GP on either side is a small sample, not a verdict. Sortable —
     a "—" always sorts last regardless of direction, same as anywhere else on this page.
   - **Teammate Quality** — average season Off Rating/20 of this player's own teammates (not
     them), game by game with a dashed season-average line. Off Rating specifically, not
     Two-Way — this measures a teammate's offensive gravity (drawing defensive attention, causing
     mismatches, setting up easy looks), not their defense. Built to answer a specific question:
     does a player's own production lean on playing next to good scorers/passers? Doesn't correct
     for this player also counting toward each teammate's own Off Rating/20 (no leave-one-out
     adjustment) — a simplification, same tradeoff every other season-long number on this page
     already makes.
   - **Assisted By** — what share of this player's own made field goals were set up by someone
     else, who, and how good (season Off Rating/20) those passers have been on average — the
     direct test of "getting fed easy looks by good players" versus creating shots alone. Field
     goals only; free throws don't carry an assist by rule.
   - **Offensive Matchup Difficulty** — average season Def Rating/20 of whoever was tagged
     *defending* this player's own shot attempts, game by game with a dashed season-average line
     — the mirror of Defensive Matchup Difficulty below, from the scorer's side: how tough have
     the defenders this player shoots over actually been? Def Rating specifically, since the
     question is how good those defenders have been defensively, not offensively. A double-teamed
     shot counts toward every tagged defender, not split; an untagged (wide-open) shot contributes
     nothing, since there's no defender to rate.
   - **Defensive Matchup Difficulty** — the defensive-side counterpart to Offensive Matchup
     Difficulty above: average season Off Rating/20 of whoever this player was tagged
     *defending*, game by game with a dashed season-average line. Does this player draw the tough
     offensive assignments, or get sheltered on weaker ones? Weighted per shot, not deduplicated
     per opponent — the same shot-by-shot weighting Stops/Beaten/Pts Allowed already use.
   - **Highlights & Lowlights** — every clip tagged to this player, across every game, pulled
     from the "Player" dropdown on each clip in the Highlight/Lowlight Reel table in Stat Entry.
     A "Go to game" button jumps to that game so you can load/rewatch it. The league-wide version
     of this table lives on the Leaderboard tab (see above).

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
   Allowed, Beaten, Stops, Def Rating, Off Rating, and Two-Way, plus the FG/3PT/FT makes-attempts
   shown — is normalized *per 20 combined points scored in the game*, not per game and not a
   raw season total. Games are capped at different totals (16 or 21), so a simple per-game
   average isn't a fair comparison between a player who mostly plays 16-point games and one who
   mostly plays 21s — normalizing by the game's combined final score (our stand-in for "how much
   game happened," since possessions aren't tracked) fixes that uniformly, not just for points
   and Off Rating. 20 is just a round number near the middle of 16–21, chosen for readability,
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
     including that game's Off Rating and Two-Way Score, and the full shot-distance split
     (`close_m`/`close_a`, `mid_m`/`mid_a`, `tp_arc_m`/`tp_arc_a`, `tp_deep_m`/`tp_deep_a`)
     alongside the plain `fgm`/`fga`/`tpm`/`tpa`. Every game with any real shots logged is in
     here, including an imbalanced (e.g. 3-on-2) one, regardless of the Include Imbalanced Games
     toggle — this file is a raw record of what actually happened, not a filtered comparison. Same
     for every other per-event CSV below except the Leaderboard one.
   - **Shot Log CSV** — one row per shot attempt (make or miss), with the shooter, result,
     points, who (if anyone) assisted it, who (if anyone) was contesting (multiple defenders
     joined with "+"), who (if anyone) blocked it, whether it went out of bounds for a turnover,
     who (if anyone) rebounded it and whether that was an OREB or DREB, the marked shot location
     if any (`shot_x`/`shot_y`, each 0-100, blank if unmarked or a free throw), which distance
     band it falls in if it's a marked field goal (`shot_band`: `close`/`midrange`/`line`/`deep`/
     blank), and the video timestamp it was logged at (seconds and mm:ss, blank if none).
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
   - **Leaderboard CSV** — season totals per player (across the exact same games the page itself
     counts, computed by the same function — respects the Include Imbalanced Games toggle just
     like the on-screen table does, unlike every other CSV above), including the full
     shot-distance split, plus PTS/20, Off Rating/20, Def Rating/20, and Two-Way/20.
     Not the per-20 rates the Leaderboard page displays for every other counting stat — the CSV
     keeps raw totals plus `games_played`, so anyone consuming it can derive whichever rate or
     average they want without losing precision to a pre-divided number.
   - **Assist Connections CSV** — one row per passer-to-scorer pairing with at least one assist,
     directional, with the assist count.
   - **Teammate Synergy CSV** — one row per (player, teammate) pair across the whole league —
     the same With/Without split as the Player Detail table, for every player at once. GP and
     Off Rating/Two-Way per 20 columns are blank on whichever side (with/without) has zero games.
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

## Starting a new season

The player roster is meant to carry over — it's one league-wide list, not scoped to any
particular season — and so, as of the **Include Past Seasons** toggle, is every game and stat:
closing a season *archives* it rather than deleting it, so a player's history stays visible and
factors back in whenever you want it to, instead of just vanishing. Only the hardcoded award/
ranking tables (below) and the locally-stored video files are actually gone for good.

1. **Export → Data Management → Download JSON** first if you want an extra backup, though nothing
   in the next step actually deletes your games or stats anymore.
2. **Export → Data Management → Start New Season.** Prompts for a label (e.g. "Summer 2026") and
   archives every current game behind today's date — they stay in the file, they're just no
   longer "current." Clears locally-stored video files (large, and re-watching last season's
   footage isn't the point of keeping the stats), and the player roster — including every
   player's height/build/role tags, whether hand-transcribed or edited in-app — is untouched,
   same as always. This is a different button from **Reset All Data** right next to it — that
   one's the actual nuclear option, wiping the roster and everything else back to a genuinely
   empty tracker.
   - The **Include Past Seasons** toggle blends every archived season back into the live
     Leaderboard/awards/Player Detail/Balance Teams numbers when it's on — off by default, so a
     new season starts clean. It's a single shared setting with two buttons that stay in sync:
     one on the Leaderboard, one on each player's own Past Seasons panel (Player Detail), so
     combining a specific player's history doesn't require hopping back to the Leaderboard first.
     Disabled with an explanatory tooltip until a season's actually been closed at least once.
   - Every player's **Past Seasons** panel, on their own Player Detail page, shows one row per
     closed season regardless of the toggle — GP, record, Off/Def/Two-Way Rating, computed live
     off the archived games (not a frozen snapshot, so these stay correct if a stat's formula
     ever changes later) — so a season's final numbers are always visible on a profile even with
     the toggle off. **Past Seasons (League)**, on the Leaderboard, is the same idea pooled across
     the whole roster instead of one player — full standings for whichever closed season you pick
     from its dropdown.
   - The Games list marks every archived game with a **📅 Past Season** badge, same idea as the
     ⚖️ imbalanced-game one, so which games are currently excluded from computed stats is visible
     without cross-referencing dates by hand.
3. **Three hardcoded tables in `app.js` still need a hand-edit — the button above can't touch
   these, since they're baked into the source file, not runtime data:**
   - `AWARD_RESULTS` — Summer 2026's closed award ballot (winners, vote standings). Replace with
     the new season's ballot once it closes, or clear it out and leave the Awards vs. Stats panel
     empty until it does.
   - `PARTY_RANKINGS` — per-date power rankings for the nights Ben's actually reviewed film for.
     Starts empty for a new season; add an entry per date as games get logged, same as this
     season's own history was built up.
   - `PLAYER_REPUTATION_DATA` — the season-average power-ranking percentiles Balance Teams falls
     back on for a player with no dashboard stats yet, imported from
     `poolean_player_profiles.xlsx`. Stale numbers here would quietly bias team-balancing toward
     last season's reputations instead of this one's — clear it out (or replace with a fresh
     export) at the same time as everything else.

   Everything else that looks like a hardcoded constant — `CLOSE_RANGE_THRESHOLD`,
   `THREE_PT_DEEP_THRESHOLD`, `CLUTCH_MARGIN_THRESHOLD`, `SECOND_CHANCE_WINDOW_SECONDS` — is a
   shot-geometry or rule threshold, not season history, and doesn't need to change for a new
   season (though revisiting them once a new season has more shot volume behind it is always
   fair game, same as any other season).

## Data schema (JSON)

```json
{
  "players": [{ "id": "player_abc", "name": "Jane Doe" }],
  "masterVideos": [{ "id": "master_abc", "name": "Aug 16 games", "fileName": "IMG_2764.MOV" }],
  "currentSeasonStartedAt": null,
  "seasonHistory": [
    { "label": "Summer 2026", "startedAt": null, "endedAt": "2026-09-02" }
  ],
  "rsvps": [
    { "id": "rsvp_abc", "date": "2026-08-24", "playerIds": ["player_abc", "player_xyz"] }
  ],
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
eFG%, TS%, Off Rating, Two-Way Score, and the defensive numbers (Pts Allowed, Opp FG%, Beaten,
Stops, Def Rating) shown in the Game Stats table and Leaderboard are all computed from this array
plus `stats` — see `shootingStats()`, `gameDefenseStats()`, `trueShootingPct()`, `effectiveFgPct()`,
`offensiveRating()`, `defensiveRating()`, and `twoWayScore()` in `app.js`. None of these are stored as
separate fields. Also computed from `shotLocation`, for any 2PT or 3PT attempt: the **Close /
Midrange / Line / Deep** shot-distance split (`shotBand()` in `app.js` — internally still
returning `"arc"` for what's displayed as "Line," only the label changed, since a code rename
wasn't worth the churn) — a shot's radial distance from the hoop (`√((x-50)² + y²)`) against
`CLOSE_RANGE_THRESHOLD` (currently 30, splitting the 2PT zone) for a 2PT attempt, or
`THREE_PT_DEEP_THRESHOLD` (currently 80, splitting the 3PT zone) for a 3PT attempt — used
because a shot right at the hoop and one from just inside the line are different shots a plain
2PT% blends together, same reasoning as the 3PT split. See the Stat Entry section above for the
full rationale and the caveat about both thresholds being provisional, not settled — especially
the 2PT one, which has no real shot-volume analysis behind it yet.

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
