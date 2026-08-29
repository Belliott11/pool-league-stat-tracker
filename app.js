// Pool League Stat Tracker
// All data lives in localStorage under STORAGE_KEY. See README.md for the JSON schema.
// Teams are picked fresh each game (pickup-style), so the roster is one league-wide list
// of players, and each game assigns players to "Team A" / "Team B" for that game only.

const STORAGE_KEY = "poolLeagueStatTracker";
const THEME_KEY = "poolLeagueTheme"; // "light" | "dark" — absent means "follow system"
const UI_STATE_KEY = "poolLeagueUiState"; // last tab + game/player in view, so a reload lands back where you were
// By the time you've reacted and clicked to log a play, playback is already a few seconds past
// it — so every captured timestamp is backed up this many seconds, landing Jump a beat before
// the play instead of right on top of (or after) it.
const TIMESTAMP_LEAD_SECONDS = 5;
// How far a single Left/Right arrow key press seeks the loaded video.
const SEEK_STEP_SECONDS = 5;
const STAT_FIELDS = ["pts", "oreb", "dreb", "ast", "stl", "blk", "tov", "pf"];
const STAT_LABELS = { pts: "PTS", oreb: "OREB", dreb: "DREB", ast: "AST", stl: "STL", blk: "BLK", tov: "TOV", pf: "PF" };

// STL/TOV/PF each tag the one opponent involved — single-select, unlike shot defenders,
// since these are inherently one-on-one events. Drives both the box score picker and the
// event log. A steal is always also a turnover for whoever it was stolen from, so logging a
// steal requires an opponent (no "No one tagged") and auto-creates the paired turnover —
// see the STL branch in the picker below. Turnover stays independently loggable for the
// (more common) cases with no steal involved: travels, bad passes, offensive fouls, etc.
const TAGGED_STAT_CONFIG = [
  { field: "tov", eventsKey: "turnoverEvents", label: "TOV", prompt: "Who forced/recovered it, if anyone?", verb: "Turnover", requireOpponent: false },
  { field: "stl", eventsKey: "stealEvents", label: "STL", prompt: "Who did they steal it from?", verb: "Steal", requireOpponent: true },
  { field: "pf", eventsKey: "foulEvents", label: "PF", prompt: "Who was fouled?", verb: "Foul", requireOpponent: false }
];

// ---------- Theme ----------
function effectiveTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") {
    document.documentElement.setAttribute("data-theme", stored);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.textContent = effectiveTheme() === "dark" ? "☀️" : "🌙";
}

document.getElementById("themeToggleBtn").addEventListener("click", () => {
  localStorage.setItem(THEME_KEY, effectiveTheme() === "dark" ? "light" : "dark");
  applyTheme();
});

applyTheme();

let state = loadState();
let currentGameId = null;
const localVideoBlobUrls = {}; // gameId -> object URL, cached per page load

// ---------- Local video storage (IndexedDB) ----------
// Game videos are usually a downloaded file, not a link, so we keep the actual file
// in this browser's IndexedDB (localStorage can't hold anything that big) — it stays
// loaded across visits on this machine, but never leaves the browser and isn't exported.
const VIDEO_DB_NAME = "poolLeagueVideos";
const VIDEO_STORE = "videos";

function openVideoDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VIDEO_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(VIDEO_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeVideoFile(gameId, file) {
  const db = await openVideoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, "readwrite");
    tx.objectStore(VIDEO_STORE).put(file, gameId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getVideoFile(gameId) {
  const db = await openVideoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, "readonly");
    const req = tx.objectStore(VIDEO_STORE).get(gameId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteVideoFile(gameId) {
  const db = await openVideoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, "readwrite");
    tx.objectStore(VIDEO_STORE).delete(gameId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllStoredVideoIds() {
  const db = await openVideoDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, "readonly");
    const req = tx.objectStore(VIDEO_STORE).getAllKeys();
    req.onsuccess = () => resolve(new Set(req.result));
    req.onerror = () => reject(req.error);
  });
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  let s = { players: [], games: [], masterVideos: [] };
  if (raw) {
    try { s = JSON.parse(raw); } catch (e) { console.error("Corrupt data, starting fresh", e); }
  }
  s.masterVideos = s.masterVideos || [];
  // fileName is the original uploaded file's name, immutable — distinct from `name`, which
  // Ben can freely retype to something less specific ("Aug 10 games"), losing the one thing
  // that actually disambiguates it from another recording of the same night.
  s.masterVideos.forEach(m => { if (m.fileName === undefined) m.fileName = null; });
  (s.games || []).forEach(normalizeGame);
  return s;
}

// Fills in fields that may be missing on games created before a feature existed
// (older saved data, or an imported file from an earlier version).
function normalizeGame(game) {
  game.teamA = game.teamA || [];
  game.teamB = game.teamB || [];
  game.stats = game.stats || [];
  game.matchups = game.matchups || [];
  game.scoringEvents = game.scoringEvents || [];
  game.turnoverEvents = game.turnoverEvents || [];
  game.stealEvents = game.stealEvents || [];
  game.foulEvents = game.foulEvents || [];
  game.plays = game.plays || [];
  if (game.winner !== "A" && game.winner !== "B") game.winner = null;
  // A game can either have its own video, or point into a shared "session" recording that
  // covers several games back-to-back — masterVideoId + videoStart/videoEnd cover that second
  // case. videoStart always has a value (playback needs somewhere to seek to); videoEnd is
  // optional — null means "runs to the end of the recording" rather than a real bound.
  game.masterVideoId = game.masterVideoId || null;
  game.videoStart = game.videoStart || 0;
  if (game.videoEnd === undefined) game.videoEnd = null;
  // Migrate the old single-defender field (from before double-teams were supported) into
  // the array form used everywhere now.
  game.scoringEvents.forEach(ev => {
    if (!ev.defenderIds) {
      ev.defenderIds = ev.defenderId ? [ev.defenderId] : [];
      delete ev.defenderId;
    }
    if (ev.assistId === undefined) ev.assistId = null;
    if (ev.blockerId === undefined) ev.blockerId = null;
    if (ev.turnoverEventId === undefined) ev.turnoverEventId = null;
    if (ev.rebounderId === undefined) ev.rebounderId = null;
    if (ev.shotLocation === undefined) ev.shotLocation = null;
  });
  // Turnovers logged before steals (or misses ruled out of bounds) auto-created a linked one
  // won't have these fields.
  game.turnoverEvents.forEach(ev => {
    if (ev.stealEventId === undefined) ev.stealEventId = null;
    if (ev.missEventId === undefined) ev.missEventId = null;
  });
  // Events logged before video-timestamp capture won't have this field — null just means
  // "no timestamp available," same as one logged with no video loaded.
  const allTimedEvents = [...game.scoringEvents, ...game.turnoverEvents, ...game.stealEvents, ...game.foulEvents, ...game.matchups];
  allTimedEvents.forEach(ev => {
    if (ev.videoTime === undefined) ev.videoTime = null;
  });
  // One-time backdate of every timestamp captured before TIMESTAMP_LEAD_SECONDS existed, so
  // old entries jump to the same few-seconds-early spot as new ones instead of landing right on
  // the play (or after it). Flagged so this never runs twice on the same game.
  if (!game.timestampsBackdated) {
    allTimedEvents.forEach(ev => {
      if (ev.videoTime !== null) ev.videoTime = Math.max(0, ev.videoTime - TIMESTAMP_LEAD_SECONDS);
    });
    game.timestampsBackdated = true;
  }
  recomputeDerivedStats(game);
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Displays an ISO date ("2026-07-05") as "Sun, Jul 5" for readability; falls back to
// the raw string for anything that isn't a plain ISO date (e.g. legacy text dates).
function formatDateDisplay(dateStr) {
  if (!dateStr) return "No date";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});

function showTab(tab) {
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("tab-" + tab).classList.add("active");
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (btn) btn.classList.add("active");
  if (tab === "export") { renderExportGameSelect(); renderMasterVideoList(); renderBrokenVideoLinks(); renderBackfillShotLocations(); renderFlaggedShotMismatches(); }
  if (tab === "leaderboard") renderLeaderboard();
  // currentGameId/currentPlayerId are always set before showTab() is called for "stats"/"player"
  // (see openGame/openPlayerDetail), so this always captures the right context alongside the tab.
  localStorage.setItem(UI_STATE_KEY, JSON.stringify({ tab, gameId: currentGameId, playerId: currentPlayerId }));
}

// ---------- Players (league-wide roster) ----------
document.getElementById("addPlayerForm").addEventListener("submit", e => {
  e.preventDefault();
  const nameInput = document.getElementById("playerNameInput");
  const name = nameInput.value.trim();
  if (!name) return;
  state.players.push({ id: uid("player"), name });
  saveState();
  nameInput.value = "";
  renderPlayers();
});

function renderPlayers() {
  const list = document.getElementById("playersList");
  list.innerHTML = "";
  if (state.players.length === 0) {
    list.innerHTML = '<p class="empty-state">No players yet. Add one above.</p>';
    return;
  }
  [...state.players].sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML = `<span>${escapeHtml(p.name)}</span>`;
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", () => {
      if (!confirm(`Remove ${p.name} from the roster? Their recorded stats stay in past games.`)) return;
      state.players = state.players.filter(pl => pl.id !== p.id);
      saveState();
      renderPlayers();
    });
    row.appendChild(delBtn);
    list.appendChild(row);
  });
}

// ---------- Games ----------
document.getElementById("addGameForm").addEventListener("submit", e => {
  e.preventDefault();
  const date = document.getElementById("gameDateInput").value;
  const videoUrl = document.getElementById("gameVideoInput").value.trim();
  const notes = document.getElementById("gameNotesInput").value.trim();
  const game = { id: uid("game"), date, videoUrl, notes, winner: null, teamA: [], teamB: [], stats: [], matchups: [], scoringEvents: [], plays: [] };
  normalizeGame(game);
  state.games.push(game);
  saveState();
  document.getElementById("addGameForm").reset();
  renderGames();
  openGame(game.id);
});

let gamesFilterText = "";
document.getElementById("gameFilterInput").addEventListener("input", e => {
  gamesFilterText = e.target.value.trim().toLowerCase();
  renderGames();
});

// Matches on date, notes, or any rostered player's name — enough to find one game in a
// growing list without needing to remember its exact date.
function gameMatchesFilter(game, filterText) {
  if (!filterText) return true;
  const playerNames = [...game.teamA, ...game.teamB]
    .map(id => state.players.find(p => p.id === id))
    .filter(Boolean)
    .map(p => p.name.toLowerCase());
  const haystack = [game.date || "", formatDateDisplay(game.date).toLowerCase(), (game.notes || "").toLowerCase(), ...playerNames].join(" ");
  return haystack.includes(filterText);
}

function renderGames() {
  renderNeedsReviewSummary();
  const list = document.getElementById("gamesList");
  list.innerHTML = "";
  if (state.games.length === 0) {
    list.innerHTML = '<p class="empty-state">No games yet. Create one above.</p>';
    return;
  }
  const filtered = [...state.games]
    .sort((x, y) => (x.date || "").localeCompare(y.date || ""))
    .filter(game => gameMatchesFilter(game, gamesFilterText));
  if (filtered.length === 0) {
    list.innerHTML = '<p class="empty-state">No games match that filter.</p>';
    return;
  }
  filtered.forEach(game => {
    const scoreA = teamScore(game, game.teamA);
    const scoreB = teamScore(game, game.teamB);
    const card = document.createElement("div");
    card.className = "game-card";
    card.dataset.gameId = game.id;
    const hasKnownVideo = !!(game.videoUrl || game.masterVideoId);
    const videoBadge = hasKnownVideo ? ' <span class="badge badge-video">🎥 Video</span>' : '<span class="video-badge-slot"></span>';
    const needsReview = game.scoringEvents.length === 0;
    // "Needs Review" only means anything once there's actually a video to review — a game with
    // no video at all just hasn't reached that point yet, not fallen behind. Local-video-only
    // games don't know their video status synchronously, so they get a slot too (resolved
    // alongside the video badge itself in markGamesWithLocalVideo).
    const reviewBadge = hasKnownVideo && needsReview
      ? ' <span class="badge badge-review">📝 Needs Review</span>'
      : (needsReview ? '<span class="review-badge-slot"></span>' : '');
    card.innerHTML = `
      <div>
        <div class="matchup-line">Team A ${scoreA} — ${scoreB} Team B</div>
        <div class="date-line">${formatDateDisplay(game.date)} · ${game.teamA.length + game.teamB.length} players${game.notes ? " · " + escapeHtml(game.notes) : ""}${videoBadge}${reviewBadge}</div>
      </div>
    `;
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", ev => {
      ev.stopPropagation();
      if (!confirm("Delete this game and all its stats?")) return;
      state.games = state.games.filter(g => g.id !== game.id);
      saveState();
      renderGames();
    });
    card.appendChild(delBtn);
    card.addEventListener("click", () => openGame(game.id));
    list.appendChild(card);
  });

  markGamesWithLocalVideo();
}

// Local video files live in IndexedDB, not `state`, so the "has video" badge (and the "Needs
// Review" badge that depends on it) for those needs a separate async pass after the
// (synchronous) game list has already rendered.
async function markGamesWithLocalVideo() {
  const ids = await getAllStoredVideoIds();
  ids.forEach(gameId => {
    const card = document.querySelector(`.game-card[data-game-id="${gameId}"]`);
    if (!card) return;
    const videoSlot = card.querySelector(".video-badge-slot");
    if (videoSlot) videoSlot.outerHTML = ' <span class="badge badge-video">🎥 Video</span>';
    const reviewSlot = card.querySelector(".review-badge-slot");
    if (reviewSlot) reviewSlot.outerHTML = ' <span class="badge badge-review">📝 Needs Review</span>';
  });
}

// Backlog indicator: how many games actually have video to watch but no shots logged yet —
// the same "reviewable" gate the per-card badge above uses, just totaled up. Independent of
// the games filter box, since the point is to surface the backlog regardless of what's shown.
async function renderNeedsReviewSummary() {
  const el = document.getElementById("needsReviewSummary");
  if (!el) return;
  const localVideoIds = new Set(await getAllStoredVideoIds());
  const count = state.games.filter(g => g.scoringEvents.length === 0 && (g.videoUrl || g.masterVideoId || localVideoIds.has(g.id))).length;
  el.textContent = count > 0
    ? `📝 ${count} game${count === 1 ? "" : "s"} with video still need${count === 1 ? "s" : ""} review.`
    : "";
}

function teamScore(game, playerIds) {
  return playerIds.reduce((sum, pid) => {
    const s = game.stats.find(st => st.playerId === pid);
    return sum + (s ? s.pts : 0);
  }, 0);
}

// Both teams' final score added together — our stand-in for "how much game happened," since
// games are capped at different targets (16 or 21) and we don't track possessions. Rates are
// expressed "per 20 combined points" (roughly the middle of that range) instead of per game,
// so a player's numbers are comparable across games regardless of which cap was in play.
function gameTotalPoints(game) {
  return teamScore(game, game.teamA) + teamScore(game, game.teamB);
}

// "W" / "L" / "T" for this player in this game, or null if they weren't in it OR the
// result isn't known yet. Once real shots are logged (scoringEvents non-empty), the actual
// score is authoritative. Until then, fall back to `game.winner` ("A"/"B") if the game was
// imported with a historical result — otherwise the game is just undecided, not a 0-0 tie.
function playerGameResult(game, playerId) {
  const onA = game.teamA.includes(playerId);
  const onB = game.teamB.includes(playerId);
  if (!onA && !onB) return null;

  let outcome; // "A" | "B" | "T"
  if (game.scoringEvents.length > 0) {
    const scoreA = teamScore(game, game.teamA);
    const scoreB = teamScore(game, game.teamB);
    outcome = scoreA === scoreB ? "T" : (scoreA > scoreB ? "A" : "B");
  } else if (game.winner === "A" || game.winner === "B") {
    outcome = game.winner;
  } else {
    return null;
  }

  if (outcome === "T") return "T";
  const wonIt = (onA && outcome === "A") || (onB && outcome === "B");
  return wonIt ? "W" : "L";
}

// ---------- Stat Entry ----------
document.getElementById("backToGamesBtn").addEventListener("click", () => {
  currentGameId = null;
  document.getElementById("statsTabBtn").hidden = true;
  showTab("games");
  renderGames();
});

function openGame(gameId) {
  currentGameId = gameId;
  document.getElementById("statsTabBtn").hidden = false;
  showTab("stats");
  renderStatEntry();
  const game = state.games.find(g => g.id === gameId);
  if (game && game.masterVideoId) {
    loadStoredMasterVideo(game.masterVideoId);
  } else {
    loadStoredVideo(gameId);
  }
}

async function loadStoredVideo(gameId) {
  if (localVideoBlobUrls[gameId]) return;
  const file = await getVideoFile(gameId);
  // Full re-render, not just the video panel — the Shot Log/Other Events/Matchups Jump buttons
  // were built while the video was still loading (so `currentVideoEl` was null and they got
  // created disabled); only re-rendering those tables too gives them a chance to enable.
  if (file && gameId === currentGameId) {
    localVideoBlobUrls[gameId] = URL.createObjectURL(file);
    renderStatEntry();
  }
}

// Session videos are keyed by their own id (not a game id) and cached here so switching
// between several games that share one recording doesn't re-fetch the blob every time.
const masterVideoBlobUrls = {};

async function loadStoredMasterVideo(masterVideoId) {
  if (masterVideoBlobUrls[masterVideoId]) {
    const game = state.games.find(g => g.id === currentGameId);
    if (game) renderStatEntry();
    return;
  }
  const file = await getVideoFile(masterVideoId);
  if (file) masterVideoBlobUrls[masterVideoId] = URL.createObjectURL(file);
  const game = state.games.find(g => g.id === currentGameId);
  if (game && game.masterVideoId === masterVideoId) renderStatEntry();
}

function getOrCreatePlayerStats(game, playerId) {
  let s = game.stats.find(st => st.playerId === playerId);
  if (!s) {
    s = { playerId, pts: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 };
    game.stats.push(s);
  }
  return s;
}

// True if two players were on the same team in this game — used to tell an offensive rebound
// (rebounder on the shooter's team) from a defensive one (rebounder on the other team).
function sameTeam(game, playerIdA, playerIdB) {
  return (game.teamA.includes(playerIdA) && game.teamA.includes(playerIdB)) ||
    (game.teamB.includes(playerIdA) && game.teamB.includes(playerIdB));
}

// ---- Shot chart geometry (shared by the entry/backfill picker and both heatmaps) ----
// Real court proportions (~30ft end to end by ~15ft wide, 2:1) as the SVG viewBox itself,
// instead of a square viewBox distorted via preserveAspectRatio="none" — a rect/circle/font
// stays visually undistorted this way as long as the CSS box matches the same 1:2 ratio (see
// .shot-chart / .heatmap-chart / .backfill-shot-row .shot-chart), since one viewBox unit then
// maps to the same number of real pixels on both axes. Stored shot coordinates stay plain
// 0-100 percentages either way — only this rendering math needs to know the real viewBox
// height. Every rendering of the chart also flips the hoop to the bottom (stored y=0 maps to
// the *largest* viewBox y, not the smallest) — consistent everywhere, logging a shot or
// reviewing one later.
const SHOT_CHART_VIEWBOX_W = 100;
const SHOT_CHART_VIEWBOX_H = 200;
function shotChartVbX(storedX) { return (storedX / 100) * SHOT_CHART_VIEWBOX_W; }
function shotChartVbY(storedY) { return SHOT_CHART_VIEWBOX_H - (storedY / 100) * SHOT_CHART_VIEWBOX_H; }

// The static court/3pt-line/hoop background shared by every shot chart rendering. `extraAttrs`
// is a raw string of additional attributes on the <svg> tag itself — e.g. `data-shot-chart` on
// the clickable entry/backfill picker, omitted on the heatmap since that one isn't a click
// target. The heatmap draws its own grid of cells on top of this same background separately
// (see renderHeatmapSvg) rather than through this function, since it needs them layered between
// the court and the 3pt line/hoop.
function renderShotChartBaseSvg(extraAttrs = "") {
  const threePtVbY = shotChartVbY(60);
  const hoopVbY = shotChartVbY(7);
  return `
    <svg class="shot-chart" viewBox="0 0 ${SHOT_CHART_VIEWBOX_W} ${SHOT_CHART_VIEWBOX_H}" ${extraAttrs}>
      <rect x="1" y="1" width="${SHOT_CHART_VIEWBOX_W - 2}" height="${SHOT_CHART_VIEWBOX_H - 2}" rx="4" class="shot-chart-court" />
      <line x1="1" y1="${threePtVbY}" x2="${SHOT_CHART_VIEWBOX_W - 1}" y2="${threePtVbY}" class="shot-chart-3pt-line" />
      <text x="${SHOT_CHART_VIEWBOX_W - 3}" y="${threePtVbY - 3}" class="shot-chart-label" text-anchor="end">3PT</text>
      <circle cx="${SHOT_CHART_VIEWBOX_W / 2}" cy="${hoopVbY}" r="4" class="shot-chart-hoop" />
    </svg>
  `;
}

// ---- Shot heatmap (Player Detail + League) ----
// Coarse on purpose — with a season's worth of shots split across dozens of players, a finer
// grid would mostly produce single-shot cells that read as 0% or 100% and mean nothing.
const HEATMAP_COLS = 5;
// Row boundaries (not just a row count) so one lands exactly on the 3pt line (y: 60, same
// threshold the Shot Log's "📍 2PT range"/"📍 3PT range" badge uses) — a zone never straddles
// it and blends a 2PT FG% together with a 3PT one. Denser inside the arc (4 rows) than beyond
// it (2 rows), since that's where shot volume concentrates.
const HEATMAP_ROW_BOUNDARIES = [0, 15, 30, 45, 60, 80, 100];

function heatmapRowForY(y) {
  const rowCount = HEATMAP_ROW_BOUNDARIES.length - 1;
  for (let r = 0; r < rowCount; r++) {
    if (y < HEATMAP_ROW_BOUNDARIES[r + 1]) return r;
  }
  return rowCount - 1; // y === 100, the top boundary itself
}

function computeHeatmapCells(shots) {
  const cellW = 100 / HEATMAP_COLS;
  const rowCount = HEATMAP_ROW_BOUNDARIES.length - 1;
  const cells = [];
  for (let r = 0; r < rowCount; r++) {
    const y = HEATMAP_ROW_BOUNDARIES[r];
    const h = HEATMAP_ROW_BOUNDARIES[r + 1] - y;
    for (let c = 0; c < HEATMAP_COLS; c++) {
      cells.push({ x: c * cellW, y, w: cellW, h, attempts: 0, makes: 0 });
    }
  }
  shots.forEach(ev => {
    const col = Math.max(0, Math.min(HEATMAP_COLS - 1, Math.floor(ev.shotLocation.x / cellW)));
    const row = heatmapRowForY(Math.max(0, Math.min(100, ev.shotLocation.y)));
    const cell = cells[row * HEATMAP_COLS + col];
    cell.attempts++;
    if (ev.made !== false) cell.makes++;
  });
  return cells;
}

// Red (0% FG) through green (100% FG) — plus a light opacity ramp so a single-shot cell (which
// is really just "make" or "miss", not a rate) reads as less confident than a well-sampled one.
function heatmapCellColor(cell) {
  const fgFrac = cell.makes / cell.attempts;
  const hue = fgFrac * 120;
  const opacity = Math.min(0.85, 0.32 + cell.attempts * 0.1);
  return `hsla(${hue}, 70%, 45%, ${opacity})`;
}

// Renders the shared court/hoop/3pt-line background with a heatmap grid over it, or null if
// there's nothing to plot yet — the caller decides what empty-state message fits its context.
function renderHeatmapSvg(shots) {
  if (shots.length === 0) return null;
  const cells = computeHeatmapCells(shots);
  const cellsSvg = cells.filter(cell => cell.attempts > 0).map(cell => {
    const vbX = shotChartVbX(cell.x);
    const vbW = (cell.w / 100) * SHOT_CHART_VIEWBOX_W;
    const vbYTop = shotChartVbY(cell.y + cell.h); // farther from the hoop = smaller stored y-span end = higher up once flipped
    const vbYBottom = shotChartVbY(cell.y);
    const vbH = vbYBottom - vbYTop;
    const cx = vbX + vbW / 2;
    const cy = vbYTop + vbH / 2;
    const fgPct = Math.round((cell.makes / cell.attempts) * 100);
    return `
      <rect x="${vbX}" y="${vbYTop}" width="${vbW}" height="${vbH}" fill="${heatmapCellColor(cell)}" stroke="var(--panel-bg)" stroke-width="0.5" />
      <text x="${cx}" y="${cy - 1}" text-anchor="middle" class="heatmap-cell-label">${cell.attempts}</text>
      <text x="${cx}" y="${cy + 7}" text-anchor="middle" class="heatmap-cell-pct">${fgPct}%</text>
    `;
  }).join("");

  const threePtVbY = shotChartVbY(60);
  const hoopVbY = shotChartVbY(7);

  // Hoop marker drawn BEFORE the cell grid (not after) so it never sits on top of a cell's
  // attempt count — it only shows through in a cell with no data there, which is the point of
  // a background reference marker in the first place.
  return `
    <svg class="shot-chart heatmap-chart" viewBox="0 0 ${SHOT_CHART_VIEWBOX_W} ${SHOT_CHART_VIEWBOX_H}">
      <rect x="1" y="1" width="${SHOT_CHART_VIEWBOX_W - 2}" height="${SHOT_CHART_VIEWBOX_H - 2}" rx="4" class="shot-chart-court" />
      <circle cx="${SHOT_CHART_VIEWBOX_W / 2}" cy="${hoopVbY}" r="4" class="shot-chart-hoop" />
      ${cellsSvg}
      <line x1="1" y1="${threePtVbY}" x2="${SHOT_CHART_VIEWBOX_W - 1}" y2="${threePtVbY}" class="shot-chart-3pt-line" />
      <text x="${SHOT_CHART_VIEWBOX_W - 3}" y="${threePtVbY - 3}" class="shot-chart-label" text-anchor="end">3PT</text>
    </svg>
  `;
}

// Shared by the player and league heatmaps — only difference is the field goal filter.
function renderHeatmapInto(containerId, allFieldGoals) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const withLocation = allFieldGoals.filter(ev => ev.shotLocation);
  const svg = renderHeatmapSvg(withLocation);
  if (!svg) {
    container.innerHTML = '<p class="empty-state">No shots with a location marked yet.</p>';
    return;
  }
  const missing = allFieldGoals.length - withLocation.length;
  container.innerHTML = `
    <div class="shot-chart-wrap">${svg}</div>
    <p class="hint" style="margin:0">${withLocation.length} of ${allFieldGoals.length} field goal${allFieldGoals.length === 1 ? "" : "s"} plotted${missing > 0 ? ` — ${missing} still missing a location` : ""}.</p>
  `;
}

function renderPlayerHeatmap(playerId) {
  const shots = [];
  state.games.forEach(g => g.scoringEvents.forEach(ev => {
    if (ev.scorerId === playerId && (ev.points === 2 || ev.points === 3)) shots.push(ev);
  }));
  renderHeatmapInto("playerHeatmap", shots);
}

function renderLeagueHeatmap() {
  const shots = [];
  state.games.forEach(g => g.scoringEvents.forEach(ev => {
    if (ev.points === 2 || ev.points === 3) shots.push(ev);
  }));
  renderHeatmapInto("leagueHeatmap", shots);
}

// PTS, AST, BLK, OREB, DREB, TOV, STL, and PF are all derived from event logs (scoringEvents /
// turnoverEvents / stealEvents / foulEvents), not clicked directly — this keeps each total
// in sync with its log, the same way PTS has always been derived from scoringEvents. Older
// scoringEvents have no `made` field at all, which means "made" (they predate misses).
function recomputeDerivedStats(game) {
  [...game.teamA, ...game.teamB].forEach(pid => {
    const s = getOrCreatePlayerStats(game, pid);
    s.pts = game.scoringEvents
      .filter(ev => ev.scorerId === pid && ev.made !== false)
      .reduce((sum, ev) => sum + ev.points, 0);
    s.ast = game.scoringEvents.filter(ev => ev.assistId === pid && ev.made !== false).length;
    s.blk = game.scoringEvents.filter(ev => ev.blockerId === pid && ev.made === false).length;
    const rebounded = game.scoringEvents.filter(ev => ev.made === false && ev.rebounderId === pid);
    s.oreb = rebounded.filter(ev => sameTeam(game, ev.scorerId, pid)).length;
    s.dreb = rebounded.filter(ev => !sameTeam(game, ev.scorerId, pid)).length;
    s.tov = game.turnoverEvents.filter(ev => ev.playerId === pid).length;
    s.stl = game.stealEvents.filter(ev => ev.playerId === pid).length;
    s.pf = game.foulEvents.filter(ev => ev.playerId === pid).length;
  });
}

// A steal is always also a turnover for whoever it was stolen from, so logging one creates
// both records — playerId committed the turnover, opponentId (the stealer) forced it. The
// turnover carries stealEventId so the two stay linked for removal (see removeTaggedEvent).
// TOV/PF just create their own single record.
function commitTaggedEvent(game, cfg, playerId, opponentId) {
  const videoTime = currentPlaybackTime();
  if (cfg.field === "stl") {
    const stealId = uid("stl");
    game.stealEvents.push({ id: stealId, playerId, opponentId, videoTime });
    // Same instant as the steal, so they share a timestamp rather than being captured twice.
    game.turnoverEvents.push({ id: uid("tov"), playerId: opponentId, opponentId: playerId, stealEventId: stealId, videoTime });
  } else {
    game[cfg.eventsKey].push({ id: uid(cfg.field), playerId, opponentId, videoTime, ...(cfg.field === "tov" ? { stealEventId: null } : {}) });
  }
}

// Removing either half of a steal/turnover pair removes both, so the two never drift out of
// sync — a turnover that "is" a steal can't exist without the steal, and vice versa.
function removeTaggedEvent(game, cfg, eventId) {
  if (cfg.field === "stl") {
    game.stealEvents = game.stealEvents.filter(e => e.id !== eventId);
    game.turnoverEvents = game.turnoverEvents.filter(e => e.stealEventId !== eventId);
  } else if (cfg.field === "tov") {
    const ev = game.turnoverEvents.find(e => e.id === eventId);
    game.turnoverEvents = game.turnoverEvents.filter(e => e.id !== eventId);
    if (ev && ev.stealEventId) game.stealEvents = game.stealEvents.filter(e => e.id !== ev.stealEventId);
    if (ev && ev.missEventId) {
      const missEv = game.scoringEvents.find(e => e.id === ev.missEventId);
      if (missEv) missEv.turnoverEventId = null;
    }
  } else {
    game[cfg.eventsKey] = game[cfg.eventsKey].filter(e => e.id !== eventId);
  }
}

// Radial distance from the hoop (x: 50, y: 0 — the same 0-100 normalized shot-chart space
// shotLocation is stored in). Not real feet, just a consistent proxy for "how far was this
// shot from the basket," used only to split 3PT attempts into two very different shots below.
function shotDistanceFromHoop(loc) {
  return Math.sqrt(Math.pow(loc.x - 50, 2) + Math.pow(loc.y, 2));
}

// Where a 3PT attempt splits into "Line" (a normal three, right at the line — Poolean's three
// is straight, not a curved arc, hence "Line" rather than "Arc") vs. "Deep" (a much
// lower-percentage near-pool-length heave) — the single blended "3PT%" number was making
// a real, makeable line three look worse than it is and a heave look better than it is. Drawn
// from a small early sample (41 total 3PT attempts logged when this threshold was introduced),
// not a settled rule — a single easy-to-find constant so it's easy to revisit as more games get
// logged, deliberately not a UI setting for a one-operator tool. Only ever applied within the
// 3PT bucket — the 2PT/3PT boundary itself (the actual 3pt line, at 60% depth) doesn't change.
const THREE_PT_DEEP_THRESHOLD = 80;
function threePtBand(loc) {
  return shotDistanceFromHoop(loc) > THREE_PT_DEEP_THRESHOLD ? "deep" : "arc";
}

// Field goal / free throw splits derived from scoringEvents for one player in one game.
// points === 1 is treated as a free throw attempt; 2 or 3 are field goal attempts.
function shootingStats(game, playerId) {
  const shots = game.scoringEvents.filter(ev => ev.scorerId === playerId);
  const made = ev => ev.made !== false;
  const fg = shots.filter(ev => ev.points === 2 || ev.points === 3);
  const three = shots.filter(ev => ev.points === 3);
  const ft = shots.filter(ev => ev.points === 1);
  // Banded 3PT split — only among attempts with a marked shot location (banding needs x/y to
  // measure distance). An unmarked 3PT attempt still counts in tpm/tpa above, just not in
  // either band below — same as the heatmap/backfill tools treat an unmarked shot as excluded,
  // so tpArcA + tpDeepA can be less than tpa until every 3PT attempt has a location marked.
  const threeArc = three.filter(ev => ev.shotLocation && threePtBand(ev.shotLocation) === "arc");
  const threeDeep = three.filter(ev => ev.shotLocation && threePtBand(ev.shotLocation) === "deep");
  return {
    fgm: fg.filter(made).length, fga: fg.length,
    tpm: three.filter(made).length, tpa: three.length,
    ftm: ft.filter(made).length, fta: ft.length,
    tpArcM: threeArc.filter(made).length, tpArcA: threeArc.length,
    tpDeepM: threeDeep.filter(made).length, tpDeepA: threeDeep.length
  };
}

function pct(made, attempted) {
  return attempted > 0 ? Math.round((made / attempted) * 100) : null;
}

// True Shooting % — scoring efficiency accounting for the extra value of 3s and the lower
// cost of free throws. Standard formula: PTS / (2 * (FGA + 0.44 * FTA)).
function trueShootingPct(pts, fga, fta) {
  const denom = 2 * (fga + 0.44 * fta);
  return denom > 0 ? Math.round((pts / denom) * 100) : null;
}

// Effective FG% — FG% adjusted so a make 3 counts as 1.5x a make 2.
function effectiveFgPct(fgm, tpm, fga) {
  return fga > 0 ? Math.round(((fgm + 0.5 * tpm) / fga) * 100) : null;
}

function formatPct(v) {
  return v === null ? "—" : `${v}%`;
}

// { playerId, points, isMiss } while waiting for the user to pick who (if anyone) was
// contesting the shot. pendingDefenders holds the multi-select in progress (a shot can be
// double-teamed) until Confirm commits it. pendingAssist is the single teammate credited
// with the assist, if any — only offered on makes, since a miss can't be assisted. pendingBlocker
// and pendingOutOfBounds are miss-only: who (if anyone) blocked it, and whether it went out of
// bounds — which, per Poolean's out-of-bounds rule, is a turnover for the shooter. pendingRebounder
// is who (if anyone, from either team) grabbed it — only offered on a live-ball miss, since an
// out-of-bounds miss never gets rebounded.
let pendingScore = null;
let pendingDefenders = new Set();
let pendingAssist = null;
let pendingBlocker = null;
let pendingOutOfBounds = false;
let pendingRebounder = null;
// { x, y } as percentages (0-100) of the shot chart, y=0 at the hoop and y=100 at the far
// wall — or null if no location was marked. Offered on field goals only (points 2 or 3), never
// on free throws, since a free throw has no shot location on the floor.
let pendingShotLocation = null;

// { playerId, kind: "tov"|"stl"|"pf" } while waiting for the user to tag the one opponent
// involved (unlike shot defenders, these are single-select and commit immediately on click —
// a turnover/steal/foul only ever involves one other player, no double-teams to account for).
let pendingTag = null;

function renderStatEntry() {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;

  document.getElementById("statEntryTitle").textContent = formatDateDisplay(game.date);
  const scoreA = teamScore(game, game.teamA);
  const scoreB = teamScore(game, game.teamB);
  document.getElementById("statEntryScore").innerHTML = `
    <span class="scoreboard-team${scoreA > scoreB ? " leading" : ""}">
      <span class="scoreboard-label">Team A</span>
      <span class="scoreboard-value">${scoreA}</span>
    </span>
    <span class="scoreboard-dash">–</span>
    <span class="scoreboard-team${scoreB > scoreA ? " leading" : ""}">
      <span class="scoreboard-value">${scoreB}</span>
      <span class="scoreboard-label">Team B</span>
    </span>
  `;

  renderVideoPanel(game);
  renderRosterAssignment(game);
  renderBoxScore(game);
  renderGameStatsTable(game);
  renderScoringLog(game);
  renderOtherEventsLog(game);
  renderMatchupForm(game);
  renderMatchupTable(game);
  renderReel(game);
}

// TOV/STL/PF, each optionally tagged with the one opponent involved (see TAGGED_STAT_CONFIG).
function renderOtherEventsLog(game) {
  const body = document.getElementById("otherEventsBody");
  if (!body) return;
  // Merging turnovers/steals/fouls means there's no single natural order (each type is its own
  // array) — sort by videoTime so the table reads in the order the plays actually happened,
  // rather than grouped by type. Events with no timestamp (no video loaded when logged) sort
  // last, since there's nothing to place them by.
  const rows = TAGGED_STAT_CONFIG.flatMap(cfg =>
    game[cfg.eventsKey].map(ev => ({ ...ev, cfg }))
  ).sort((a, b) => {
    if (a.videoTime === null) return b.videoTime === null ? 0 : 1;
    if (b.videoTime === null) return -1;
    return a.videoTime - b.videoTime;
  });
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">No turnovers, steals, or fouls recorded yet.</td></tr>';
    return;
  }
  body.innerHTML = "";
  rows.forEach(ev => {
    const player = state.players.find(p => p.id === ev.playerId);
    const opponent = ev.opponentId ? state.players.find(p => p.id === ev.opponentId) : null;
    const viaSteal = ev.cfg.field === "tov" && ev.stealEventId;
    const viaMiss = ev.cfg.field === "tov" && ev.missEventId;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${ev.cfg.verb}${viaSteal ? ' <span class="hint" style="margin:0">(via steal)</span>' : ""}${viaMiss ? ' <span class="hint" style="margin:0">(shot out of bounds)</span>' : ""}</td>
      <td>${player ? escapeHtml(player.name) : "?"}</td>
      <td>${opponent ? escapeHtml(opponent.name) : "—"}</td>
      <td>${formatVideoTime(ev.videoTime)}</td>
    `;
    const tdJump = document.createElement("td");
    tdJump.appendChild(createJumpButton(ev.videoTime));
    tr.appendChild(tdJump);
    const tdBtn = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.title = viaSteal ? "Also removes the linked steal" : viaMiss ? "Un-marks the linked shot as an out-of-bounds turnover" : (ev.cfg.field === "stl" ? "Also removes the linked turnover" : "");
    delBtn.addEventListener("click", () => {
      removeTaggedEvent(game, ev.cfg, ev.id);
      recomputeDerivedStats(game);
      saveState();
      renderStatEntry();
    });
    tdBtn.appendChild(delBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
}

// ---- Shot log (every make and miss, with who if anyone was contesting/assisting) ----
// Editing state for an already-logged shot in the Shot Log — separate from pendingScore/etc.
// (the new-entry flow in the box score) so the two never collide if both happened to be open
// at once. Covers defender/assist/blocker/rebounder only, not make-vs-miss, points, or the
// out-of-bounds turnover link — those change what other records exist (the linked turnover,
// the derived pts) rather than just who's tagged, so correcting one of those still means
// deleting and re-logging the shot.
let editingShotId = null;
let editDefenders = new Set();
let editAssist = null;
let editBlocker = null;
let editRebounder = null;

function renderShotEditRow(game, ev) {
  const scorerOnA = game.teamA.includes(ev.scorerId);
  const opponentIds = scorerOnA ? game.teamB : game.teamA;
  const teammateIds = (scorerOnA ? game.teamA : game.teamB).filter(id => id !== ev.scorerId);
  const opponents = opponentIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const teammates = teammateIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const scorer = state.players.find(p => p.id === ev.scorerId);
  const made = ev.made !== false;

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td colspan="8" class="stat-cell expanded" style="text-align:left">
      <div class="stat-label">Editing ${scorer ? escapeHtml(scorer.name) : "?"}'s ${made ? "make" : "miss"} — defender/assist/block/rebound only</div>
      <div class="stat-label" style="margin-top:6px">Contesting defender(s)</div>
      <div class="defender-pick-list">
        <button type="button" class="secondary-btn${editDefenders.size === 0 ? " selected" : ""}" data-edit-nodefender="1">No defender</button>
        ${opponents.map(o => `<button type="button" class="secondary-btn${editDefenders.has(o.id) ? " selected" : ""}" data-edit-defender="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
      </div>
      ${made ? `
        <div class="stat-label" style="margin-top:6px">Assisted by?</div>
        <div class="defender-pick-list">
          <button type="button" class="secondary-btn${!editAssist ? " selected" : ""}" data-edit-noassist="1">No assist</button>
          ${teammates.map(t => `<button type="button" class="secondary-btn${editAssist === t.id ? " selected" : ""}" data-edit-assist="${t.id}">${escapeHtml(t.name)}</button>`).join("")}
        </div>
      ` : `
        <div class="stat-label" style="margin-top:6px">Blocked by?</div>
        <div class="defender-pick-list">
          <button type="button" class="secondary-btn${!editBlocker ? " selected" : ""}" data-edit-noblock="1">No block</button>
          ${opponents.map(o => `<button type="button" class="secondary-btn${editBlocker === o.id ? " selected" : ""}" data-edit-block="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
        </div>
        ${ev.turnoverEventId ? '<p class="hint" style="margin:6px 0 0">This miss is marked out of bounds, so it has no rebounder — remove and re-log it if that\'s wrong.</p>' : `
          <div class="stat-label" style="margin-top:6px">Rebounded by?</div>
          <div class="defender-pick-list">
            <button type="button" class="secondary-btn${!editRebounder ? " selected" : ""}" data-edit-norebound="1">No rebound tracked</button>
            <button type="button" class="secondary-btn${editRebounder === ev.scorerId ? " selected" : ""}" data-edit-rebound="${ev.scorerId}">${scorer ? escapeHtml(scorer.name) : "?"} (self)</button>
            ${teammates.map(t => `<button type="button" class="secondary-btn${editRebounder === t.id ? " selected" : ""}" data-edit-rebound="${t.id}">${escapeHtml(t.name)}</button>`).join("")}
            ${opponents.map(o => `<button type="button" class="secondary-btn${editRebounder === o.id ? " selected" : ""}" data-edit-rebound="${o.id}">${escapeHtml(o.name)} (opp)</button>`).join("")}
          </div>
        `}
      `}
      <div class="confirm-row">
        <button type="button" class="highlight-btn confirm-btn" data-edit-save="1">✓ Save</button>
        <button type="button" class="secondary-btn" data-edit-cancel="1">Cancel</button>
      </div>
    </td>
  `;
  tr.querySelector("[data-edit-nodefender]").addEventListener("click", () => { editDefenders.clear(); renderScoringLog(game); });
  tr.querySelectorAll("[data-edit-defender]").forEach(b => {
    b.addEventListener("click", () => {
      const id = b.dataset.editDefender;
      if (editDefenders.has(id)) editDefenders.delete(id); else editDefenders.add(id);
      renderScoringLog(game);
    });
  });
  if (made) {
    tr.querySelector("[data-edit-noassist]").addEventListener("click", () => { editAssist = null; renderScoringLog(game); });
    tr.querySelectorAll("[data-edit-assist]").forEach(b => {
      b.addEventListener("click", () => { editAssist = editAssist === b.dataset.editAssist ? null : b.dataset.editAssist; renderScoringLog(game); });
    });
  } else {
    tr.querySelector("[data-edit-noblock]").addEventListener("click", () => { editBlocker = null; renderScoringLog(game); });
    tr.querySelectorAll("[data-edit-block]").forEach(b => {
      b.addEventListener("click", () => { editBlocker = editBlocker === b.dataset.editBlock ? null : b.dataset.editBlock; renderScoringLog(game); });
    });
    if (!ev.turnoverEventId) {
      tr.querySelector("[data-edit-norebound]").addEventListener("click", () => { editRebounder = null; renderScoringLog(game); });
      tr.querySelectorAll("[data-edit-rebound]").forEach(b => {
        b.addEventListener("click", () => { editRebounder = editRebounder === b.dataset.editRebound ? null : b.dataset.editRebound; renderScoringLog(game); });
      });
    }
  }
  tr.querySelector("[data-edit-save]").addEventListener("click", () => {
    ev.defenderIds = [...editDefenders];
    if (made) {
      ev.assistId = editAssist;
    } else {
      ev.blockerId = editBlocker;
      if (!ev.turnoverEventId) ev.rebounderId = editRebounder;
    }
    editingShotId = null;
    recomputeDerivedStats(game);
    saveState();
    renderStatEntry();
  });
  tr.querySelector("[data-edit-cancel]").addEventListener("click", () => {
    editingShotId = null;
    renderScoringLog(game);
  });
  return tr;
}

function renderScoringLog(game) {
  const body = document.getElementById("scoringLogBody");
  if (!body) return;
  body.innerHTML = "";
  if (game.scoringEvents.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="empty-state">No shots recorded yet.</td></tr>';
    return;
  }
  [...game.scoringEvents].reverse().forEach(ev => {
    const scorer = state.players.find(p => p.id === ev.scorerId);
    const made = ev.made !== false;
    const assister = ev.assistId ? state.players.find(p => p.id === ev.assistId) : null;
    const blocker = ev.blockerId ? state.players.find(p => p.id === ev.blockerId) : null;
    const rebounder = ev.rebounderId ? state.players.find(p => p.id === ev.rebounderId) : null;
    let resultBadge = made
      ? '<span class="badge badge-highlight">✅ Make</span>'
      : '<span class="badge badge-lowlight">❌ Miss</span>';
    if (blocker) resultBadge += ` <span class="badge">Blocked: ${escapeHtml(blocker.name)}</span>`;
    if (ev.turnoverEventId) resultBadge += ' <span class="badge">Out of bounds → TOV</span>';
    if (rebounder) {
      const kind = sameTeam(game, ev.scorerId, rebounder.id) ? "OREB" : "DREB";
      resultBadge += ` <span class="badge">${kind}: ${escapeHtml(rebounder.name)}</span>`;
    }
    if (ev.shotLocation) {
      const zone = ev.shotLocation.y >= 60 ? "3PT range" : "2PT range";
      resultBadge += ` <span class="badge">📍 ${zone}</span>`;
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${scorer ? escapeHtml(scorer.name) : "?"}</td>
      <td>${resultBadge}</td>
      <td>${ev.points}</td>
      <td>${assister ? escapeHtml(assister.name) : "—"}</td>
      <td>${defenderNames(ev.defenderIds)}</td>
      <td>${formatVideoTime(ev.videoTime)}</td>
    `;
    const tdJump = document.createElement("td");
    tdJump.appendChild(createJumpButton(ev.videoTime));
    tr.appendChild(tdJump);
    const tdBtn = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = editingShotId === ev.id ? "Editing…" : "Edit";
    editBtn.disabled = editingShotId === ev.id;
    editBtn.title = "Fix the tagged defender, assist, block, or rebound — not make/miss, points, or out-of-bounds";
    editBtn.addEventListener("click", () => {
      editingShotId = ev.id;
      editDefenders = new Set(ev.defenderIds || []);
      editAssist = ev.assistId;
      editBlocker = ev.blockerId;
      editRebounder = ev.rebounderId;
      renderScoringLog(game);
    });
    tdBtn.appendChild(editBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", () => {
      game.scoringEvents = game.scoringEvents.filter(e => e.id !== ev.id);
      if (ev.turnoverEventId) game.turnoverEvents = game.turnoverEvents.filter(e => e.id !== ev.turnoverEventId);
      if (editingShotId === ev.id) editingShotId = null;
      recomputeDerivedStats(game);
      saveState();
      renderStatEntry();
    });
    tdBtn.appendChild(delBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
    if (editingShotId === ev.id) body.appendChild(renderShotEditRow(game, ev));
  });
}

// ---- Video ----
let currentVideoEl = null; // the live <video> element for the open game, when there is one

// The live playback position when an event is logged, so it can be jumped back to later —
// null if no video is loaded (or it's a YouTube/generic iframe embed, which this tool can't
// read the playback position of). Backed up by TIMESTAMP_LEAD_SECONDS since you're always
// clicking a moment after the play actually happened.
function currentPlaybackTime() {
  return currentVideoEl ? Math.max(0, currentVideoEl.currentTime - TIMESTAMP_LEAD_SECONDS) : null;
}

// Left/Right arrow keys scrub the loaded video by SEEK_STEP_SECONDS, from anywhere on the
// page — skipped while typing in a field (a text input, a number input like the video-start
// field, etc.) so arrow keys still move the cursor/adjust the value there like normal.
document.addEventListener("keydown", e => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (!currentVideoEl) return;
  const tag = document.activeElement ? document.activeElement.tagName : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (document.activeElement && document.activeElement.isContentEditable)) return;
  e.preventDefault();
  const delta = e.key === "ArrowLeft" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS;
  currentVideoEl.currentTime = Math.max(0, currentVideoEl.currentTime + delta);
});

function renderMasterVideoControls(game) {
  const select = document.getElementById("masterVideoSelect");
  select.innerHTML = '<option value="">— None (use a video just for this game) —</option>' +
    state.masterVideos.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  select.value = game.masterVideoId || "";

  const startRow = document.getElementById("masterVideoStartRow");
  const endRow = document.getElementById("masterVideoEndRow");
  const detachRow = document.getElementById("masterVideoDetachRow");
  if (game.masterVideoId) {
    startRow.hidden = false;
    endRow.hidden = false;
    detachRow.hidden = false;
    document.getElementById("videoStartInput").value = game.videoStart;
    document.getElementById("videoStartFormatted").textContent = `(${formatTime(game.videoStart)})`;
    document.getElementById("videoEndInput").value = game.videoEnd === null ? "" : game.videoEnd;
    document.getElementById("videoEndFormatted").textContent = game.videoEnd === null ? "" : `(${formatTime(game.videoEnd)})`;
  } else {
    startRow.hidden = true;
    endRow.hidden = true;
    detachRow.hidden = true;
  }
}

document.getElementById("masterVideoSelect").addEventListener("change", e => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  game.masterVideoId = e.target.value || null;
  if (game.masterVideoId && !game.videoStart) game.videoStart = 0;
  game.videoEnd = null; // any previously-set end belonged to whatever recording was attached before
  saveState();
  renderVideoPanel(game);
  renderGames();
  if (game.masterVideoId) loadStoredMasterVideo(game.masterVideoId);
});

document.getElementById("masterVideoInput").addEventListener("change", async e => {
  const game = state.games.find(g => g.id === currentGameId);
  const file = e.target.files[0];
  e.target.value = "";
  if (!game || !file) return;
  const name = prompt("Name this session recording (e.g. the date, or \"Aug 16 games\"):", file.name.replace(/\.[^.]+$/, ""));
  if (name === null) return;
  const masterId = uid("master");
  masterVideoBlobUrls[masterId] = URL.createObjectURL(file);
  state.masterVideos.push({ id: masterId, name: name.trim() || file.name, fileName: file.name });
  game.masterVideoId = masterId;
  game.videoStart = 0;
  game.videoEnd = null;
  await storeVideoFile(masterId, file);
  saveState();
  renderVideoPanel(game);
  renderGames();
});

document.getElementById("videoStartInput").addEventListener("change", e => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  game.videoStart = Math.max(0, parseFloat(e.target.value) || 0);
  saveState();
  document.getElementById("videoStartFormatted").textContent = `(${formatTime(game.videoStart)})`;
  if (currentVideoEl) currentVideoEl.currentTime = game.videoStart;
});

document.getElementById("videoEndInput").addEventListener("change", e => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  const raw = e.target.value.trim();
  game.videoEnd = raw === "" ? null : Math.max(0, parseFloat(raw) || 0);
  saveState();
  document.getElementById("videoEndFormatted").textContent = game.videoEnd === null ? "" : `(${formatTime(game.videoEnd)})`;
});

document.getElementById("setEndFromPlaybackBtn").addEventListener("click", () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game || !currentVideoEl) return;
  game.videoEnd = currentVideoEl.currentTime;
  saveState();
  document.getElementById("videoEndInput").value = game.videoEnd.toFixed(1);
  document.getElementById("videoEndFormatted").textContent = `(${formatTime(game.videoEnd)})`;
});

document.getElementById("clearVideoEndBtn").addEventListener("click", () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  game.videoEnd = null;
  saveState();
  document.getElementById("videoEndInput").value = "";
  document.getElementById("videoEndFormatted").textContent = "";
});

document.getElementById("setStartFromPlaybackBtn").addEventListener("click", () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game || !currentVideoEl) return;
  game.videoStart = currentVideoEl.currentTime;
  saveState();
  document.getElementById("videoStartInput").value = game.videoStart.toFixed(1);
  document.getElementById("videoStartFormatted").textContent = `(${formatTime(game.videoStart)})`;
});

document.getElementById("detachMasterVideoBtn").addEventListener("click", () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  game.masterVideoId = null;
  saveState();
  renderVideoPanel(game);
  renderGames();
});

// Identifies which video panel is currently showing, so renderVideoPanel can tell "same
// source as last render" apart from "the video actually needs to change." Without this,
// every stat click — which re-renders the whole Stat Entry view — would tear down and
// recreate the <video>/<iframe>, resetting playback to 0:00 and interrupting whatever was
// playing every single time you tagged a stat.
let renderedVideoKey = null;

function renderVideoPanel(game) {
  document.getElementById("videoUrlInput").value = game.videoUrl || "";
  renderMasterVideoControls(game);

  const wrap = document.getElementById("videoPlayerWrap");

  if (game.masterVideoId) {
    const masterUrl = masterVideoBlobUrls[game.masterVideoId];
    if (!masterUrl) {
      renderedVideoKey = null; // nothing stable rendered yet — always retry until it's ready
      wrap.innerHTML = '<p class="empty-state">Loading session video…</p>';
      currentVideoEl = null;
      updateReelButtons();
      return;
    }
    const key = `master:${game.id}:${game.masterVideoId}`;
    if (key === renderedVideoKey && wrap.querySelector("video")) { updateReelButtons(); return; }
    renderedVideoKey = key;
    wrap.innerHTML = `<video controls src="${masterUrl}"></video>`;
    const videoEl = wrap.querySelector("video");
    videoEl.addEventListener("loadedmetadata", () => { videoEl.currentTime = game.videoStart; }, { once: true });
    currentVideoEl = videoEl;
    updateReelButtons();
    return;
  }

  const localUrl = localVideoBlobUrls[game.id];
  if (localUrl) {
    const key = `local:${game.id}:${localUrl}`;
    if (key === renderedVideoKey && wrap.querySelector("video")) { updateReelButtons(); return; }
    renderedVideoKey = key;
    wrap.innerHTML = `<video controls src="${localUrl}"></video><p class="hint"><button type="button" id="removeLocalVideoBtn" class="icon-btn">Remove local video</button></p>`;
    document.getElementById("removeLocalVideoBtn").addEventListener("click", () => removeLocalVideo(game));
    currentVideoEl = wrap.querySelector("video");
    updateReelButtons();
    return;
  }
  if (!game.videoUrl) {
    renderedVideoKey = null;
    wrap.innerHTML = '<p class="empty-state">No video loaded yet.</p>';
    currentVideoEl = null;
    updateReelButtons();
    return;
  }
  const url = game.videoUrl;
  const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
  if (ytMatch) {
    const key = `yt:${game.id}:${url}`;
    if (key === renderedVideoKey && wrap.querySelector("iframe")) { updateReelButtons(); return; }
    renderedVideoKey = key;
    currentVideoEl = null;
    wrap.innerHTML = `<iframe src="https://www.youtube.com/embed/${ytMatch[1]}" allowfullscreen></iframe>`;
    updateReelButtons();
    return;
  }
  if (/\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(url)) {
    const key = `url:${game.id}:${url}`;
    if (key === renderedVideoKey && wrap.querySelector("video")) { updateReelButtons(); return; }
    renderedVideoKey = key;
    wrap.innerHTML = `<video controls src="${escapeHtml(url)}"></video>`;
    currentVideoEl = wrap.querySelector("video");
    updateReelButtons();
    return;
  }
  const key = `iframe:${game.id}:${url}`;
  if (key === renderedVideoKey && wrap.querySelector("iframe")) { updateReelButtons(); return; }
  renderedVideoKey = key;
  currentVideoEl = null;
  wrap.innerHTML = `
    <iframe src="${escapeHtml(url)}" allowfullscreen></iframe>
    <p class="hint">If the video above doesn't load, <a href="${escapeHtml(url)}" target="_blank" rel="noopener">open it in a new tab</a> instead.</p>
  `;
  updateReelButtons();
}

document.getElementById("saveVideoUrlBtn").addEventListener("click", async () => {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  if (localVideoBlobUrls[game.id]) {
    URL.revokeObjectURL(localVideoBlobUrls[game.id]);
    delete localVideoBlobUrls[game.id];
    await deleteVideoFile(game.id);
  }
  game.videoUrl = document.getElementById("videoUrlInput").value.trim();
  saveState();
  renderVideoPanel(game);
  renderGames();
});

document.getElementById("localVideoInput").addEventListener("change", async e => {
  const game = state.games.find(g => g.id === currentGameId);
  const file = e.target.files[0];
  e.target.value = "";
  if (!game || !file) return;
  if (localVideoBlobUrls[game.id]) URL.revokeObjectURL(localVideoBlobUrls[game.id]);
  localVideoBlobUrls[game.id] = URL.createObjectURL(file);
  renderVideoPanel(game);
  await storeVideoFile(game.id, file);
});

async function removeLocalVideo(game) {
  if (localVideoBlobUrls[game.id]) {
    URL.revokeObjectURL(localVideoBlobUrls[game.id]);
    delete localVideoBlobUrls[game.id];
  }
  await deleteVideoFile(game.id);
  renderVideoPanel(game);
}

// ---- Roster assignment ----
function setPlayerAssignment(game, playerId, value) {
  game.teamA = game.teamA.filter(id => id !== playerId);
  game.teamB = game.teamB.filter(id => id !== playerId);
  if (value === "A") game.teamA.push(playerId);
  if (value === "B") game.teamB.push(playerId);
}

// Compact chip-based assignment: each column only shows the players actually on that
// team, plus a small "add player" dropdown limited to whoever isn't assigned anywhere
// yet — much less to scan than listing all 21 roster players with a select each.
function renderRosterAssignment(game) {
  const wrap = document.getElementById("rosterAssignment");
  wrap.innerHTML = "";
  if (state.players.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No players on the roster yet. Add players in the Players tab.</p>';
    return;
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  const assignedIds = new Set([...game.teamA, ...game.teamB]);
  const available = state.players.filter(p => !assignedIds.has(p.id)).sort(byName);

  [["Team A", game.teamA], ["Team B", game.teamB]].forEach(([label, playerIds]) => {
    const col = document.createElement("div");
    col.className = "roster-team-col";
    col.innerHTML = `<h4>${label}</h4>`;

    const chipWrap = document.createElement("div");
    chipWrap.className = "roster-chip-list";
    const players = playerIds.map(id => state.players.find(p => p.id === id)).filter(Boolean).sort(byName);
    if (players.length === 0) {
      chipWrap.innerHTML = '<span class="empty-state">No players yet.</span>';
    }
    players.forEach(p => {
      const chip = document.createElement("span");
      chip.className = "roster-chip";
      chip.innerHTML = `${escapeHtml(p.name)} <button type="button" title="Remove from ${label}">&times;</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        setPlayerAssignment(game, p.id, "none");
        saveState();
        renderStatEntry();
      });
      chipWrap.appendChild(chip);
    });
    col.appendChild(chipWrap);

    const addSelect = document.createElement("select");
    addSelect.className = "roster-add-select";
    addSelect.innerHTML = `<option value="">+ Add player…</option>` +
      available.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    addSelect.addEventListener("change", () => {
      if (!addSelect.value) return;
      setPlayerAssignment(game, addSelect.value, label === "Team A" ? "A" : "B");
      saveState();
      renderStatEntry();
    });
    if (available.length === 0) addSelect.disabled = true;
    col.appendChild(addSelect);

    wrap.appendChild(col);
  });
}

// ---- Box score ----
function renderBoxScore(game) {
  const cols = document.getElementById("boxScoreColumns");
  cols.innerHTML = "";
  [["Team A", game.teamA, game.teamB], ["Team B", game.teamB, game.teamA]].forEach(([label, playerIds, opponentIds]) => {
    const box = document.createElement("div");
    box.className = "team-box";
    box.innerHTML = `<h3>${label}</h3>`;
    if (playerIds.length === 0) {
      box.innerHTML += '<p class="empty-state">No players assigned yet.</p>';
    }
    playerIds.forEach(pid => {
      const p = state.players.find(pl => pl.id === pid);
      if (!p) return;
      const s = getOrCreatePlayerStats(game, pid);
      const card = document.createElement("div");
      card.className = "player-stat-card";
      card.innerHTML = `<div class="name-row"><span>${escapeHtml(p.name)}</span></div>`;
      const grid = document.createElement("div");
      grid.className = "stat-grid";

      const ptsCell = document.createElement("div");
      ptsCell.className = "stat-cell";

      if (pendingScore && pendingScore.playerId === pid) {
        const opponents = opponentIds.map(id => state.players.find(pl2 => pl2.id === id)).filter(Boolean);
        const teammates = playerIds.filter(id => id !== pid).map(id => state.players.find(pl2 => pl2.id === id)).filter(Boolean);
        const verb = pendingScore.isMiss ? "contesting the miss" : "scored on";
        const selectedNames = opponents.filter(o => pendingDefenders.has(o.id)).map(o => o.name);
        const label = selectedNames.length > 0 ? selectedNames.join(" + ") : "No defender";
        const assister = pendingAssist ? state.players.find(pl2 => pl2.id === pendingAssist) : null;
        const blocker = pendingBlocker ? state.players.find(pl2 => pl2.id === pendingBlocker) : null;
        const rebounder = pendingRebounder ? state.players.find(pl2 => pl2.id === pendingRebounder) : null;
        ptsCell.classList.add("expanded");
        ptsCell.innerHTML = `
          <div class="stat-label">Who was ${verb}? (${pendingScore.isMiss ? "miss" : "+"}${pendingScore.points}) — ${escapeHtml(label)}</div>
          <div class="defender-pick-list">
            <button type="button" class="secondary-btn${pendingDefenders.size === 0 ? " selected" : ""}" data-nodefender="1">No defender</button>
            ${opponents.map(o => `<button type="button" class="secondary-btn${pendingDefenders.has(o.id) ? " selected" : ""}" data-defender="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
          </div>
          ${pendingScore.points === 1 ? "" : `
            <div class="stat-label" style="margin-top:6px">Where was it from? ${pendingShotLocation ? "" : "— not marked"}</div>
            <div class="shot-chart-wrap">
              ${renderShotChartBaseSvg("data-shot-chart")}
              <button type="button" class="icon-btn" data-clear-location="1">Clear location</button>
            </div>
          `}
          ${pendingScore.isMiss ? `
            <div class="stat-label" style="margin-top:6px">Blocked by? — ${blocker ? escapeHtml(blocker.name) : "No block"}</div>
            <div class="defender-pick-list">
              <button type="button" class="secondary-btn${!pendingBlocker ? " selected" : ""}" data-noblock="1">No block</button>
              ${opponents.map(o => `<button type="button" class="secondary-btn${pendingBlocker === o.id ? " selected" : ""}" data-block="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
            </div>
            <div class="stat-label" style="margin-top:6px">Where did it end up?</div>
            <div class="defender-pick-list">
              <button type="button" class="secondary-btn${!pendingOutOfBounds ? " selected" : ""}" data-live="1">Live ball</button>
              <button type="button" class="secondary-btn${pendingOutOfBounds ? " selected" : ""}" data-oob="1">Out of bounds (turnover)</button>
            </div>
            ${pendingOutOfBounds ? "" : `
              <div class="stat-label" style="margin-top:6px">Rebounded by? — ${rebounder ? escapeHtml(rebounder.name) : "No rebound tracked"}</div>
              <div class="defender-pick-list">
                <button type="button" class="secondary-btn${!pendingRebounder ? " selected" : ""}" data-norebound="1">No rebound tracked</button>
                <button type="button" class="secondary-btn${pendingRebounder === pid ? " selected" : ""}" data-rebound="${pid}">${escapeHtml(p.name)} (self)</button>
                ${teammates.map(t => `<button type="button" class="secondary-btn${pendingRebounder === t.id ? " selected" : ""}" data-rebound="${t.id}">${escapeHtml(t.name)}</button>`).join("")}
                ${opponents.map(o => `<button type="button" class="secondary-btn${pendingRebounder === o.id ? " selected" : ""}" data-rebound="${o.id}">${escapeHtml(o.name)} (opp)</button>`).join("")}
              </div>
            `}
          ` : `
            <div class="stat-label" style="margin-top:6px">Assisted by? — ${assister ? escapeHtml(assister.name) : "No assist"}</div>
            <div class="defender-pick-list">
              <button type="button" class="secondary-btn${!pendingAssist ? " selected" : ""}" data-noassist="1">No assist</button>
              ${teammates.map(t => `<button type="button" class="secondary-btn${pendingAssist === t.id ? " selected" : ""}" data-assist="${t.id}">${escapeHtml(t.name)}</button>`).join("")}
            </div>
          `}
          <div class="confirm-row">
            <button type="button" class="highlight-btn confirm-btn" data-confirm="1">✓ Confirm</button>
            <button type="button" class="secondary-btn" data-cancel="1">Cancel</button>
          </div>
        `;
        ptsCell.querySelector("[data-nodefender]").addEventListener("click", () => {
          pendingDefenders.clear();
          renderStatEntry();
        });
        ptsCell.querySelectorAll("button[data-defender]").forEach(b => {
          b.addEventListener("click", () => {
            const id = b.dataset.defender;
            if (pendingDefenders.has(id)) pendingDefenders.delete(id);
            else pendingDefenders.add(id);
            renderStatEntry();
          });
        });
        if (pendingScore.points !== 1) {
          const chartEl = ptsCell.querySelector("[data-shot-chart]");
          setShotChartDot(chartEl, pendingShotLocation);
          chartEl.addEventListener("click", e => {
            const rect = chartEl.getBoundingClientRect();
            const xFrac = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
            const yFrac = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
            // The chart renders flipped (hoop at the bottom), so the raw fraction from the top
            // of the box needs inverting to land back on the stored convention (y=0 at the hoop).
            pendingShotLocation = { x: xFrac, y: 100 - yFrac };
            renderStatEntry();
          });
          ptsCell.querySelector("[data-clear-location]").addEventListener("click", () => {
            pendingShotLocation = null;
            renderStatEntry();
          });
        }
        if (!pendingScore.isMiss) {
          ptsCell.querySelector("[data-noassist]").addEventListener("click", () => {
            pendingAssist = null;
            renderStatEntry();
          });
          ptsCell.querySelectorAll("button[data-assist]").forEach(b => {
            b.addEventListener("click", () => {
              pendingAssist = pendingAssist === b.dataset.assist ? null : b.dataset.assist;
              renderStatEntry();
            });
          });
        } else {
          ptsCell.querySelector("[data-noblock]").addEventListener("click", () => {
            pendingBlocker = null;
            renderStatEntry();
          });
          ptsCell.querySelectorAll("button[data-block]").forEach(b => {
            b.addEventListener("click", () => {
              pendingBlocker = pendingBlocker === b.dataset.block ? null : b.dataset.block;
              renderStatEntry();
            });
          });
          ptsCell.querySelector("[data-live]").addEventListener("click", () => {
            pendingOutOfBounds = false;
            renderStatEntry();
          });
          ptsCell.querySelector("[data-oob]").addEventListener("click", () => {
            pendingOutOfBounds = true;
            pendingRebounder = null;
            renderStatEntry();
          });
          if (!pendingOutOfBounds) {
            ptsCell.querySelector("[data-norebound]").addEventListener("click", () => {
              pendingRebounder = null;
              renderStatEntry();
            });
            ptsCell.querySelectorAll("button[data-rebound]").forEach(b => {
              b.addEventListener("click", () => {
                pendingRebounder = pendingRebounder === b.dataset.rebound ? null : b.dataset.rebound;
                renderStatEntry();
              });
            });
          }
        }
        ptsCell.querySelector("[data-confirm]").addEventListener("click", () => {
          const scoreEventId = uid("score");
          game.scoringEvents.push({
            id: scoreEventId,
            scorerId: pid,
            points: pendingScore.points,
            made: !pendingScore.isMiss,
            defenderIds: [...pendingDefenders],
            assistId: pendingScore.isMiss ? null : pendingAssist,
            blockerId: pendingScore.isMiss ? pendingBlocker : null,
            turnoverEventId: null,
            rebounderId: pendingScore.isMiss && !pendingOutOfBounds ? pendingRebounder : null,
            shotLocation: pendingScore.points === 1 ? null : pendingShotLocation,
            videoTime: currentPlaybackTime()
          });
          if (pendingScore.isMiss && pendingOutOfBounds) {
            // Credit whoever forced it out, if known — the blocker if it was blocked, else the
            // lone defender if there was exactly one (with a double-team, it's ambiguous).
            const opponentId = pendingBlocker || (pendingDefenders.size === 1 ? [...pendingDefenders][0] : null);
            const tovId = uid("tov");
            game.turnoverEvents.push({ id: tovId, playerId: pid, opponentId, stealEventId: null, missEventId: scoreEventId, videoTime: currentPlaybackTime() });
            game.scoringEvents.find(e => e.id === scoreEventId).turnoverEventId = tovId;
          }
          pendingScore = null;
          pendingDefenders = new Set();
          pendingAssist = null;
          pendingBlocker = null;
          pendingOutOfBounds = false;
          pendingRebounder = null;
          pendingShotLocation = null;
          recomputeDerivedStats(game);
          saveState();
          renderStatEntry();
        });
        ptsCell.querySelector("[data-cancel]").addEventListener("click", () => {
          pendingScore = null;
          pendingDefenders = new Set();
          pendingAssist = null;
          pendingBlocker = null;
          pendingOutOfBounds = false;
          pendingRebounder = null;
          pendingShotLocation = null;
          renderStatEntry();
        });
      } else {
        ptsCell.innerHTML = `
          <div class="stat-label">PTS</div>
          <div class="stat-value">${s.pts}</div>
          <div class="stat-buttons">
            <button type="button" data-points="1">+1</button>
            <button type="button" data-points="2">+2</button>
            <button type="button" data-points="3">+3</button>
            <button type="button" data-undo="1">-</button>
          </div>
          <div class="stat-label" style="margin-top:4px">MISS</div>
          <div class="stat-buttons">
            <button type="button" class="secondary-btn" data-miss="1">1</button>
            <button type="button" class="secondary-btn" data-miss="2">2</button>
            <button type="button" class="secondary-btn" data-miss="3">3</button>
          </div>
        `;
        ptsCell.querySelectorAll("button[data-points]").forEach(b => {
          b.addEventListener("click", () => {
            pendingScore = { playerId: pid, points: parseInt(b.dataset.points, 10), isMiss: false };
            pendingDefenders = new Set();
            pendingAssist = null;
            pendingBlocker = null;
            pendingOutOfBounds = false;
            pendingRebounder = null;
            pendingShotLocation = null;
            renderStatEntry();
          });
        });
        ptsCell.querySelectorAll("button[data-miss]").forEach(b => {
          b.addEventListener("click", () => {
            pendingScore = { playerId: pid, points: parseInt(b.dataset.miss, 10), isMiss: true };
            pendingDefenders = new Set();
            pendingAssist = null;
            pendingBlocker = null;
            pendingOutOfBounds = false;
            pendingRebounder = null;
            pendingShotLocation = null;
            renderStatEntry();
          });
        });
        ptsCell.querySelector("[data-undo]").addEventListener("click", () => {
          for (let i = game.scoringEvents.length - 1; i >= 0; i--) {
            if (game.scoringEvents[i].scorerId === pid && game.scoringEvents[i].made !== false) {
              game.scoringEvents.splice(i, 1);
              break;
            }
          }
          recomputeDerivedStats(game);
          saveState();
          renderStatEntry();
        });
      }
      grid.appendChild(ptsCell);

      // AST/BLK/OREB/DREB are all derived from scoringEvents (assistId on makes, blockerId and
      // rebounderId on misses), not clicked directly — read-only here, same pattern as
      // PTS/TOV/STL/PF. There's no manual +1/- stat left; every box score number traces back to
      // a specific tagged shot.
      ["ast", "blk", "oreb", "dreb"].forEach(field => {
        const cell = document.createElement("div");
        cell.className = "stat-cell";
        cell.innerHTML = `<div class="stat-label">${STAT_LABELS[field]}</div><div class="stat-value">${s[field]}</div>`;
        grid.appendChild(cell);
      });

      TAGGED_STAT_CONFIG.forEach(cfg => {
        const cell = document.createElement("div");
        cell.className = "stat-cell";

        if (pendingTag && pendingTag.playerId === pid && pendingTag.kind === cfg.field) {
          const opponents = opponentIds.map(id => state.players.find(pl2 => pl2.id === id)).filter(Boolean);
          cell.classList.add("expanded");
          cell.innerHTML = `
            <div class="stat-label">${cfg.prompt}</div>
            <div class="defender-pick-list">
              ${cfg.requireOpponent ? "" : '<button type="button" class="secondary-btn" data-opp="">No one tagged</button>'}
              ${opponents.map(o => `<button type="button" class="secondary-btn" data-opp="${o.id}">${escapeHtml(o.name)}</button>`).join("")}
            </div>
            <button type="button" class="icon-btn" data-cancel="1">Cancel</button>
          `;
          cell.querySelectorAll("button[data-opp]").forEach(b => {
            b.addEventListener("click", () => {
              commitTaggedEvent(game, cfg, pid, b.dataset.opp || null);
              pendingTag = null;
              recomputeDerivedStats(game);
              saveState();
              renderStatEntry();
            });
          });
          cell.querySelector("[data-cancel]").addEventListener("click", () => {
            pendingTag = null;
            renderStatEntry();
          });
        } else {
          cell.innerHTML = `
            <div class="stat-label">${cfg.label}</div>
            <div class="stat-value">${s[cfg.field]}</div>
            <div class="stat-buttons">
              <button type="button" data-add="1">+1</button>
              <button type="button" data-undo="1">-</button>
            </div>
          `;
          cell.querySelector("[data-add]").addEventListener("click", () => {
            pendingTag = { playerId: pid, kind: cfg.field };
            renderStatEntry();
          });
          cell.querySelector("[data-undo]").addEventListener("click", () => {
            const arr = game[cfg.eventsKey];
            for (let i = arr.length - 1; i >= 0; i--) {
              if (arr[i].playerId === pid) { removeTaggedEvent(game, cfg, arr[i].id); break; }
            }
            recomputeDerivedStats(game);
            saveState();
            renderStatEntry();
          });
        }
        grid.appendChild(cell);
      });

      card.appendChild(grid);
      box.appendChild(card);
    });
    cols.appendChild(box);
  });
}

// Defensive numbers derived from scoringEvents.defenderIds — "beaten" only counts made
// shots against them; a contested miss is a stop, not a beaten defender. Opponent FG% is
// the shooting percentage of everyone this player was tagged as defending, contested or
// not (i.e. of Beaten + Stops) — a real per-defender shooting percentage allowed. A
// double-teamed shot counts fully against every tagged defender, not split between them —
// so these totals mean "shots this player was involved in defending," and summing them
// across all defenders in a game can exceed the game's actual points.
function gameDefenseStats(game, playerId) {
  const against = game.scoringEvents.filter(ev => (ev.defenderIds || []).includes(playerId));
  const madeAgainst = against.filter(ev => ev.made !== false);
  const timesBeaten = madeAgainst.length;
  const stops = against.filter(ev => ev.made === false).length;
  return {
    ptsAllowed: madeAgainst.reduce((sum, ev) => sum + ev.points, 0),
    timesBeaten,
    stops,
    oppFgPct: pct(timesBeaten, timesBeaten + stops)
  };
}

function defenderNames(defenderIds) {
  if (!defenderIds || defenderIds.length === 0) return "No defender";
  return defenderIds.map(id => {
    const p = state.players.find(pl => pl.id === id);
    return p ? escapeHtml(p.name) : "?";
  }).join(" + ");
}

function formatShootingSplit(m, a) {
  return a > 0 ? `${m}/${a} (${pct(m, a)}%)` : "—";
}

function formatAstTov(ast, tov) {
  if (tov === 0) return ast === 0 ? "0.0" : "∞";
  return (ast / tov).toFixed(1);
}

// Hollinger's Game Score — a single-number "how good was this game" read.
function gameScore(s, sh) {
  return s.pts + 0.4 * sh.fgm - 0.7 * sh.fga - 0.4 * (sh.fta - sh.ftm)
    + 0.7 * s.oreb + 0.3 * s.dreb + s.stl + 0.7 * s.ast + 0.7 * s.blk - 0.4 * s.pf - s.tov;
}

// GmSc's defensive counterpart, built from the same per-shot defender tagging as Pts
// Allowed/Beaten/Stops. Stops and Beaten are weighted symmetrically at 1.0 — a stop denies a
// possession the same way GmSc weights a steal — and Points Allowed at 0.4 so a 3-point beat
// scores worse than a 2-point beat without double-penalizing the same possession the Beaten
// count already covers. Opp FG% isn't its own term since it's just Beaten / (Beaten + Stops) —
// a separate term would double-count the same information. A player never tagged as a
// defender has stops/timesBeaten/ptsAllowed all at 0, so this is naturally 0 for them rather
// than penalizing conservative tagging (per Ben's tag-only-when-clear policy).
function defensiveImpact(def) {
  return def.stops - def.timesBeaten - 0.4 * def.ptsAllowed;
}

function twoWayScore(s, sh, def) {
  return gameScore(s, sh) + defensiveImpact(def);
}

// Poolean rule: "If one player has fouled three times in a single game, that player is
// ejected for the remainder of the game." PF is already derived from foulEvents — this just
// flags when a game's count has crossed that line, wherever PF is shown in a box score.
const FOUL_OUT_THRESHOLD = 3;
function foulCellHtml(pf) {
  return pf >= FOUL_OUT_THRESHOLD
    ? `${pf} <span class="badge badge-lowlight" title="${FOUL_OUT_THRESHOLD} fouls — ejected for the rest of this game">🚫 OUT</span>`
    : String(pf);
}

function renderGameStatsTable(game) {
  const body = document.getElementById("gameStatsTableBody");
  if (!body) return;
  body.innerHTML = "";
  const rows = [...game.teamA.map(id => ({ id, team: "A" })), ...game.teamB.map(id => ({ id, team: "B" }))];
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="22" class="empty-state">No players assigned yet.</td></tr>';
    return;
  }
  rows.forEach(({ id, team }) => {
    const p = state.players.find(pl => pl.id === id);
    if (!p) return;
    const s = getOrCreatePlayerStats(game, id);
    const def = gameDefenseStats(game, id);
    const sh = shootingStats(game, id);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="sticky-col">${escapeHtml(p.name)}</td>
      <td>${team}</td>
      <td>${s.pts}</td>
      <td>${formatShootingSplit(sh.fgm, sh.fga)}</td>
      <td>${formatShootingSplit(sh.tpm, sh.tpa)}</td>
      <td>${formatShootingSplit(sh.ftm, sh.fta)}</td>
      <td>${formatPct(effectiveFgPct(sh.fgm, sh.tpm, sh.fga))}</td>
      <td>${formatPct(trueShootingPct(s.pts, sh.fga, sh.fta))}</td>
      <td>${s.oreb}</td>
      <td>${s.dreb}</td>
      <td>${s.ast}</td>
      <td>${s.stl}</td>
      <td>${s.blk}</td>
      <td>${s.tov}</td>
      <td>${formatAstTov(s.ast, s.tov)}</td>
      <td>${foulCellHtml(s.pf)}</td>
      <td>${def.ptsAllowed}</td>
      <td>${formatPct(def.oppFgPct)}</td>
      <td>${def.timesBeaten}</td>
      <td>${def.stops}</td>
      <td>${gameScore(s, sh).toFixed(1)}</td>
      <td>${twoWayScore(s, sh, def).toFixed(1)}</td>
    `;
    body.appendChild(tr);
  });
}

// ---- Highlight / lowlight reel ----
function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function formatVideoTime(videoTime) {
  return videoTime === null || videoTime === undefined ? "—" : formatTime(videoTime);
}

// A small "▶ Jump" button for any logged event's timestamp — disabled when there's no video
// loaded right now, or the event predates timestamp capture and has no time to jump to.
function createJumpButton(videoTime) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary-btn";
  btn.textContent = "▶ Jump";
  btn.disabled = !currentVideoEl || videoTime === null || videoTime === undefined;
  btn.addEventListener("click", () => {
    if (!currentVideoEl || videoTime === null || videoTime === undefined) return;
    currentVideoEl.currentTime = videoTime;
    currentVideoEl.play();
  });
  return btn;
}

function updateReelButtons() {
  const hBtn = document.getElementById("markHighlightBtn");
  const lBtn = document.getElementById("markLowlightBtn");
  if (!hBtn || !lBtn) return;
  const enabled = !!currentVideoEl;
  hBtn.disabled = !enabled;
  lBtn.disabled = !enabled;
}

function markPlay(type) {
  const game = state.games.find(g => g.id === currentGameId);
  if (!game || !currentVideoEl) return;
  const t = currentVideoEl.currentTime || 0;
  game.plays.push({
    id: uid("play"),
    type,
    start: Math.max(0, t - 5),
    end: t + 5,
    playerId: null,
    note: ""
  });
  saveState();
  renderReel(game);
}

document.getElementById("markHighlightBtn").addEventListener("click", () => markPlay("highlight"));
document.getElementById("markLowlightBtn").addEventListener("click", () => markPlay("lowlight"));

function renderReel(game) {
  updateReelButtons();
  const body = document.getElementById("reelTableBody");
  if (!body) return;
  body.innerHTML = "";
  if (game.plays.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="empty-state">No clips marked yet.</td></tr>';
    return;
  }
  const gamePlayers = [...game.teamA, ...game.teamB].map(id => state.players.find(p => p.id === id)).filter(Boolean);

  [...game.plays].sort((a, b) => a.start - b.start).forEach(play => {
    const tr = document.createElement("tr");

    const typeTd = document.createElement("td");
    typeTd.innerHTML = play.type === "highlight"
      ? '<span class="badge badge-highlight">🔥 Highlight</span>'
      : '<span class="badge badge-lowlight">👎 Lowlight</span>';
    tr.appendChild(typeTd);

    const startTd = document.createElement("td");
    const startInput = document.createElement("input");
    startInput.type = "number";
    startInput.step = "0.5";
    startInput.min = "0";
    startInput.className = "reel-time-input";
    startInput.value = play.start.toFixed(1);
    startInput.title = formatTime(play.start);
    startInput.addEventListener("change", () => {
      play.start = Math.max(0, parseFloat(startInput.value) || 0);
      saveState();
    });
    startTd.appendChild(startInput);
    tr.appendChild(startTd);

    const endTd = document.createElement("td");
    const endInput = document.createElement("input");
    endInput.type = "number";
    endInput.step = "0.5";
    endInput.min = "0";
    endInput.className = "reel-time-input";
    endInput.value = play.end.toFixed(1);
    endInput.title = formatTime(play.end);
    endInput.addEventListener("change", () => {
      play.end = Math.max(play.start, parseFloat(endInput.value) || play.start);
      saveState();
    });
    endTd.appendChild(endInput);
    tr.appendChild(endTd);

    const playerTd = document.createElement("td");
    const playerSelect = document.createElement("select");
    playerSelect.innerHTML = `<option value="">—</option>` +
      gamePlayers.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    playerSelect.value = play.playerId || "";
    playerSelect.addEventListener("change", () => {
      play.playerId = playerSelect.value || null;
      saveState();
    });
    playerTd.appendChild(playerSelect);
    tr.appendChild(playerTd);

    const noteTd = document.createElement("td");
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.className = "reel-note-input";
    noteInput.placeholder = "Note";
    noteInput.value = play.note || "";
    noteInput.addEventListener("change", () => {
      play.note = noteInput.value.trim();
      saveState();
    });
    noteTd.appendChild(noteInput);
    tr.appendChild(noteTd);

    const jumpTd = document.createElement("td");
    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "secondary-btn";
    jumpBtn.textContent = "▶ Jump";
    jumpBtn.disabled = !currentVideoEl;
    jumpBtn.addEventListener("click", () => {
      if (!currentVideoEl) return;
      currentVideoEl.currentTime = play.start;
      currentVideoEl.play();
    });
    jumpTd.appendChild(jumpBtn);
    tr.appendChild(jumpTd);

    const delTd = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", () => {
      game.plays = game.plays.filter(pl => pl.id !== play.id);
      saveState();
      renderReel(game);
    });
    delTd.appendChild(delBtn);
    tr.appendChild(delTd);

    body.appendChild(tr);
  });
}

// ---- Matchups ----
function renderMatchupForm(game) {
  const defSel = document.getElementById("defenderSelect");
  const offSel = document.getElementById("offenderSelect");
  const gamePlayers = [...game.teamA, ...game.teamB]
    .map(id => state.players.find(p => p.id === id))
    .filter(Boolean);
  const optionsFor = (players) => players.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  defSel.innerHTML = optionsFor(gamePlayers);
  offSel.innerHTML = optionsFor(gamePlayers);
}

document.getElementById("addMatchupForm").addEventListener("submit", e => {
  e.preventDefault();
  const game = state.games.find(g => g.id === currentGameId);
  if (!game) return;
  const defenderId = document.getElementById("defenderSelect").value;
  const offenderId = document.getElementById("offenderSelect").value;
  const note = document.getElementById("matchupNoteInput").value.trim();
  if (!defenderId || !offenderId) return;
  game.matchups.push({ id: uid("matchup"), defenderId, offenderId, note, videoTime: currentPlaybackTime() });
  saveState();
  document.getElementById("matchupNoteInput").value = "";
  renderMatchupTable(game);
});

function renderMatchupTable(game) {
  const body = document.getElementById("matchupTableBody");
  body.innerHTML = "";
  if (game.matchups.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">No matchups recorded yet.</td></tr>';
    return;
  }
  game.matchups.forEach(m => {
    const defender = state.players.find(p => p.id === m.defenderId);
    const offender = state.players.find(p => p.id === m.offenderId);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${defender ? escapeHtml(defender.name) : "?"}</td>
      <td>${offender ? escapeHtml(offender.name) : "?"}</td>
      <td>${escapeHtml(m.note || "")}</td>
      <td>${formatVideoTime(m.videoTime)}</td>
    `;
    const tdJump = document.createElement("td");
    tdJump.appendChild(createJumpButton(m.videoTime));
    tr.appendChild(tdJump);
    const tdBtn = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", () => {
      game.matchups = game.matchups.filter(mm => mm.id !== m.id);
      saveState();
      renderMatchupTable(game);
    });
    tdBtn.appendChild(delBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
}

// ---------- Leaderboard ----------
function computeLeaderboard() {
  return state.players.map(p => {
    // Only games actually logged with real shots count toward GP/averages — a game that's
    // just been rostered (or only carries a historical winner imported with no shot-level
    // detail, see playerGameResult()) has nothing to average, and counting it would drag
    // every average toward 0 for a game nobody has reviewed yet.
    const gamesPlayed = state.games.filter(g => (g.teamA.includes(p.id) || g.teamB.includes(p.id)) && g.scoringEvents.length > 0);
    const totals = { pts: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 };
    const shooting = { fgm: 0, fga: 0, tpm: 0, tpa: 0, tpArcM: 0, tpArcA: 0, tpDeepM: 0, tpDeepA: 0, ftm: 0, fta: 0 };
    const defense = { ptsAllowed: 0, timesBeaten: 0, stops: 0 };
    let wins = 0, losses = 0, ties = 0, combinedPoints = 0;
    gamesPlayed.forEach(g => {
      const s = g.stats.find(st => st.playerId === p.id);
      if (s) STAT_FIELDS.forEach(f => totals[f] += s[f]);
      const sh = shootingStats(g, p.id);
      Object.keys(shooting).forEach(k => shooting[k] += sh[k]);
      const def = gameDefenseStats(g, p.id);
      defense.ptsAllowed += def.ptsAllowed;
      defense.timesBeaten += def.timesBeaten;
      defense.stops += def.stops;
      combinedPoints += gameTotalPoints(g);
      const result = playerGameResult(g, p.id);
      if (result === "W") wins++;
      else if (result === "L") losses++;
      else if (result === "T") ties++;
    });
    const gp = gamesPlayed.length;
    // Both are linear combinations of raw counts, so the season total equals the sum of each
    // game's value — computing once on the summed totals gives the same result as summing
    // per-game numbers would.
    const totalGameScore = gameScore(totals, shooting);
    const totalTwoWay = totalGameScore + defensiveImpact(defense);
    // Every counting stat on the Leaderboard is a rate per 20 combined points scored in the
    // game, not a per-game average — games are capped at different totals (16 or 21), so a
    // player who mostly plays 16-point games isn't fairly compared to one who mostly plays
    // 21s by a plain per-game average. The combined final score stands in for "how much game
    // happened," since possessions aren't tracked. This is the same reasoning PTS/20 and
    // GmSc/20 always used, just applied uniformly instead of singling those two out.
    const per20 = value => combinedPoints > 0 ? (value / combinedPoints) * 20 : 0;
    const rate = {};
    STAT_FIELDS.forEach(f => { rate[f] = per20(totals[f]); });
    const rateShooting = {};
    Object.keys(shooting).forEach(k => { rateShooting[k] = per20(shooting[k]); });
    const rateDefense = {
      ptsAllowed: per20(defense.ptsAllowed),
      timesBeaten: per20(defense.timesBeaten),
      stops: per20(defense.stops)
    };
    // Last 5 games (by date, not insertion order), same per-20 math as the season — a quick
    // "how are they trending lately" read next to the season number, not a separate stat family.
    // Fewer than 5 games played just means fewer games in the window, not a blank/"—" — the
    // comparison still means something with 2-3 games, just noisier.
    const last5Games = [...gamesPlayed].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 5);
    const last5 = computeRateSummaryForGames(p.id, last5Games);
    const seasonGmScPer20 = per20(totalGameScore);
    const last5Delta = last5.gp > 0 ? last5.gmScorePer20 - seasonGmScPer20 : null;
    // ±0.5 counts as flat rather than a real trend — otherwise a 0.1 wobble reads as a signal.
    // "●" for flat, not "-"/"–" — a dash next to a number reads as a minus sign, not "no change."
    const last5Trend = last5Delta === null ? "" : last5Delta > 0.5 ? "▲" : last5Delta < -0.5 ? "▼" : "●";
    return {
      player: p, gp, totals, shooting, defense, rate, rateShooting, rateDefense,
      wins, losses, ties,
      winPct: (wins + losses) > 0 ? pct(wins, wins + losses) : null,
      gameScorePer20: seasonGmScPer20,
      twoWayPer20: per20(totalTwoWay),
      // Season-long sums, not per-20 rates — for the rare comparison (MVP) where "played a lot
      // and contributed a lot" should outweigh a slightly higher rate over fewer games.
      gameScoreTotal: totalGameScore,
      twoWayTotal: totalTwoWay,
      stocks: totals.stl + totals.blk,
      astTov: formatAstTov(totals.ast, totals.tov),
      last5Gp: last5.gp, last5GmScPer20: last5.gmScorePer20, last5TwoWayPer20: last5.twoWayPer20, last5Trend
    };
  });
}

// Every passer-to-scorer connection, directional — Alice assisting Bob is tracked separately
// from Bob assisting Alice. A real chemistry signal straight from the Shot Log's assist tags,
// unlike win/loss (which the real Poolean site already tracks per duo).
function computeAssistConnections() {
  const totals = {}; // "passerId|scorerId" -> count
  state.games.forEach(g => {
    g.scoringEvents.forEach(ev => {
      if (!ev.assistId || ev.made === false) return;
      const key = `${ev.assistId}|${ev.scorerId}`;
      totals[key] = (totals[key] || 0) + 1;
    });
  });
  return Object.entries(totals).map(([key, count]) => {
    const [passerId, scorerId] = key.split("|");
    return {
      passer: state.players.find(p => p.id === passerId),
      scorer: state.players.find(p => p.id === scorerId),
      count
    };
  }).filter(r => r.passer && r.scorer).sort((a, b) => b.count - a.count);
}

// The shot that actually brought the winning team to their final score — the real
// game-ending basket in a race-to-a-target format, not just "scored late." Only credited when
// the shot in question has a real video timestamp: without one, "last in array order" isn't
// trustworthy enough to call a specific shot the game-winner, since edits/backfill workflows
// don't guarantee insertion order matches game order. A tied game has no winner and therefore
// no winning shot.
function gameWinningShot(game) {
  if (game.scoringEvents.length === 0) return null;
  const scoreA = teamScore(game, game.teamA);
  const scoreB = teamScore(game, game.teamB);
  if (scoreA === scoreB) return null;
  const winningTeam = scoreA > scoreB ? game.teamA : game.teamB;
  const makes = game.scoringEvents.filter(ev => ev.made !== false);
  if (makes.length === 0) return null;
  // Only trust the ordering when *every* make in the game has a real timestamp — a single
  // untimed shot could have happened at any point in the game, early or late, so a partial set
  // of timestamps can't reliably say which specific shot actually came last.
  if (makes.some(ev => ev.videoTime === null || ev.videoTime === undefined)) return null;
  const last = [...makes].sort((a, b) => a.videoTime - b.videoTime)[makes.length - 1];
  return winningTeam.includes(last.scorerId) ? last : null;
}

// Season count of game-winning buckets per player — a discrete "big moment" tally, not a per-20
// rate, since a rate would round a rare, memorable thing down to an unreadable decimal. Kept in
// its own panel (like Out-of-Bounds Misses) rather than as a Leaderboard column.
function computeGameWinningBuckets() {
  const totals = {};
  state.games.forEach(game => {
    const shot = gameWinningShot(game);
    if (shot) totals[shot.scorerId] = (totals[shot.scorerId] || 0) + 1;
  });
  return Object.entries(totals)
    .map(([playerId, count]) => ({ player: state.players.find(p => p.id === playerId), count }))
    .filter(r => r.player)
    .sort((a, b) => b.count - a.count);
}

function renderGameWinningBucketsPanel() {
  const body = document.getElementById("gameWinningBucketsBody");
  if (!body) return;
  const rows = computeGameWinningBuckets();
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="2" class="empty-state">No game-winning buckets identified yet — needs a timestamped make that closes out a decided game.</td></tr>'
    : rows.map(r => `<tr><td>${escapeHtml(r.player.name)}</td><td>${r.count}</td></tr>`).join("");
}

// Summer 2026's voted awards, straight from that season's closed ballot (award_results in the
// original season spreadsheet) — fixed, historical facts, not something this tool derives or
// could recompute. `winners` are player slugs, which match this tool's own player.id for anyone
// imported from poolean-seed.json (see INTEGRATION.md). `statKey` says which tracked stat is
// the closest comparison for that award; null means there's no tracked equivalent to compare
// against, so the panel says that plainly instead of forcing a stretch metric onto it. MVP uses
// season-long Two-Way total rather than a per-20 rate, on the theory that "played a lot and
// contributed a lot" should outweigh a slightly higher rate over fewer games for that specific
// award — every other award here still compares on the per-20 rate.
const AWARD_RESULTS = [
  { key: "mvp", label: "MVP", winners: ["ben"], statKey: "twoWayTotal" },
  { key: "best-player", label: "Best Player", winners: ["phillip"], statKey: "twoWay" },
  { key: "dpoy", label: "Defensive Player of the Year", winners: ["adam"], statKey: "defImpact" },
  { key: "clutch", label: "Clutch", winners: ["phillip"], statKey: "gwb" },
  { key: "mip-season", label: "Most Improved (Season)", winners: ["zach"], statKey: "trend" },
  { key: "mip-yoy", label: "Most Improved (Year-over-Year)", winners: ["zach"], statKey: "trend" },
  { key: "teammate", label: "Best Teammate", winners: ["ben"], statKey: "teammateLift" },
  { key: "first-team", label: "First Team", winners: ["phillip", "ben", "sean"], statKey: "twoWay" },
  { key: "second-team", label: "Second Team", winners: ["adam", "reilly", "evan"], statKey: "twoWay" },
  { key: "best-duo", label: "Best Duo", winners: ["phillip", "ben"], statKey: "twoWay", isDuo: true },
  { key: "worst-duo", label: "Worst Duo", winners: ["phillip", "viraj"], statKey: "twoWay", isDuo: true }
];

// For each award, resolves its voted winner(s) against whatever's actually logged in this
// browser right now — a rank/value on the closest tracked stat, or an honest "no games logged
// yet" / "no comparable tracked stat" rather than a fabricated number. Recomputed fresh every
// render, same as every other Leaderboard panel — nothing about awards or their pairing to a
// stat is stored in `state`.
function computeAwardsVsStats() {
  const board = computeLeaderboard().filter(r => r.gp > 0);
  const twoWayRanked = [...board].sort((a, b) => b.twoWayPer20 - a.twoWayPer20);
  const twoWayTotalRanked = [...board].sort((a, b) => b.twoWayTotal - a.twoWayTotal);
  const defRanked = [...board].sort((a, b) => defensiveImpact(b.rateDefense) - defensiveImpact(a.rateDefense));
  const gwbRanked = computeGameWinningBuckets();

  function rankDetail(ranked, slug, valueFn, label) {
    const idx = ranked.findIndex(r => r.player.id === slug);
    if (idx === -1) return "No games logged yet";
    return `${label}: ${valueFn(ranked[idx]).toFixed(1)} (#${idx + 1} of ${ranked.length})`;
  }

  function winnerDetail(slug, statKey) {
    if (statKey === "twoWay") return rankDetail(twoWayRanked, slug, r => r.twoWayPer20, "Two-Way/20");
    if (statKey === "twoWayTotal") return rankDetail(twoWayTotalRanked, slug, r => r.twoWayTotal, "Two-Way (season)");
    if (statKey === "defImpact") return rankDetail(defRanked, slug, r => defensiveImpact(r.rateDefense), "Def Impact/20");
    if (statKey === "gwb") {
      const idx = gwbRanked.findIndex(r => r.player.id === slug);
      if (idx === -1) return "0 game-winning buckets this season";
      return `${gwbRanked[idx].count} game-winning bucket${gwbRanked[idx].count === 1 ? "" : "s"} this season (#${idx + 1} of ${gwbRanked.length})`;
    }
    if (statKey === "trend") {
      const row = board.find(r => r.player.id === slug);
      return row ? `Last 5: ${row.last5Trend} ${row.last5TwoWayPer20.toFixed(1)} vs. season ${row.twoWayPer20.toFixed(1)} Two-Way/20` : "No games logged yet";
    }
    if (statKey === "teammateLift") {
      const lifts = [];
      state.players.forEach(p => {
        if (p.id === slug) return;
        const synergy = computeTeammateSynergy(p.id).find(s => s.teammate.id === slug);
        if (synergy && synergy.with.gp > 0 && synergy.without.gp > 0) lifts.push(synergy.with.twoWayPer20 - synergy.without.twoWayPer20);
      });
      if (lifts.length === 0) return "Not enough With/Without games logged yet";
      const avg = lifts.reduce((a, b) => a + b, 0) / lifts.length;
      return `Teammates average ${avg >= 0 ? "+" : ""}${avg.toFixed(1)} Two-Way/20 with them on the floor (${lifts.length} teammate${lifts.length === 1 ? "" : "s"} with enough games)`;
    }
    return "No directly comparable tracked stat";
  }

  return AWARD_RESULTS.map(award => {
    const winners = award.winners.map(slug => ({
      slug,
      player: state.players.find(p => p.id === slug),
      detail: winnerDetail(slug, award.statKey)
    }));
    let duoDetail = null;
    if (award.isDuo && award.winners.length === 2) {
      const [aId, bId] = award.winners;
      const total = computeAssistConnections()
        .filter(c => (c.passer.id === aId && c.scorer.id === bId) || (c.passer.id === bId && c.scorer.id === aId))
        .reduce((sum, c) => sum + c.count, 0);
      duoDetail = total > 0 ? `${total} assist${total === 1 ? "" : "s"} between them, either direction` : "No assist connections between them logged yet";
    }
    return { ...award, winners, duoDetail };
  });
}

function renderAwardsVsStats() {
  const wrap = document.getElementById("awardsVsStats");
  if (!wrap) return;
  wrap.innerHTML = "";
  computeAwardsVsStats().forEach(award => {
    const row = document.createElement("div");
    row.className = "award-row";
    const winnersHtml = award.winners.map(w => `
      <div class="award-winner">
        <span class="award-winner-name">${w.player ? escapeHtml(w.player.name) : `${escapeHtml(w.slug)} (not in current roster)`}</span>
        <span class="hint" style="margin:0">${escapeHtml(w.detail)}</span>
      </div>
    `).join("");
    row.innerHTML = `
      <div class="award-label">${escapeHtml(award.label)}</div>
      <div class="award-winners">${winnersHtml}</div>
      ${award.duoDetail ? `<div class="hint" style="margin:4px 0 0">${escapeHtml(award.duoDetail)}</div>` : ""}
    `;
    wrap.appendChild(row);
  });
}

function renderAssistSynergy() {
  const body = document.getElementById("assistSynergyBody");
  const rows = computeAssistConnections();
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="3" class="empty-state">No assists logged yet.</td></tr>'
    : rows.map(r => `<tr><td>${escapeHtml(r.passer.name)}</td><td>${escapeHtml(r.scorer.name)}</td><td>${r.count}</td></tr>`).join("");
}

// The Arc/Deep 3PT split, league-wide — kept in its own panel rather than as columns on the
// main Leaderboard table, since it's a secondary cut most people only need occasionally, not
// something worth widening every row of the main table for. Reuses computeLeaderboard()'s
// existing per-player shooting totals rather than recomputing them.
function renderThreePtDistancePanel() {
  const body = document.getElementById("threePtDistanceBody");
  const rows = computeLeaderboard()
    .filter(r => r.shooting.tpArcA + r.shooting.tpDeepA > 0)
    .sort((a, b) => (b.shooting.tpArcA + b.shooting.tpDeepA) - (a.shooting.tpArcA + a.shooting.tpDeepA));
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="3" class="empty-state">No 3-pointers with a marked shot location yet.</td></tr>'
    : rows.map(r => `<tr><td>${escapeHtml(r.player.name)}</td><td>${formatShootingSplit(r.shooting.tpArcM, r.shooting.tpArcA)}</td><td>${formatShootingSplit(r.shooting.tpDeepM, r.shooting.tpDeepA)}</td></tr>`).join("");
}

// How often a player's own missed shot ends up out of bounds (a turnover for them, per
// Poolean's "whoever last touched it loses possession" rule) vs. staying live for either team
// to rebound. Scoped to misses specifically — a make can never go out of bounds — so this reads
// as "when this player misses, how often does the ball leave their hands for good," not a
// shooting-accuracy stat.
function computeOutOfBoundsStats() {
  const totals = {}; // playerId -> { misses, oob }
  state.games.forEach(g => {
    g.scoringEvents.filter(ev => ev.made === false).forEach(ev => {
      const t = totals[ev.scorerId] = totals[ev.scorerId] || { misses: 0, oob: 0 };
      t.misses++;
      if (ev.turnoverEventId) t.oob++;
    });
  });
  return Object.entries(totals)
    .map(([playerId, v]) => ({ player: state.players.find(p => p.id === playerId), ...v }))
    .filter(r => r.player)
    .sort((a, b) => b.misses - a.misses);
}

function renderOutOfBoundsPanel() {
  const rows = computeOutOfBoundsStats();
  const summaryEl = document.getElementById("outOfBoundsSummary");
  const totalMisses = rows.reduce((sum, r) => sum + r.misses, 0);
  const totalOob = rows.reduce((sum, r) => sum + r.oob, 0);
  summaryEl.textContent = totalMisses > 0
    ? `League-wide: ${totalOob} of ${totalMisses} missed shots this season went out of bounds (${formatPct(pct(totalOob, totalMisses))}).`
    : "No missed shots logged yet.";
  const body = document.getElementById("outOfBoundsBody");
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="4" class="empty-state">No missed shots logged yet.</td></tr>'
    : rows.map(r => `<tr><td>${escapeHtml(r.player.name)}</td><td>${r.misses}</td><td>${r.oob}</td><td>${formatPct(pct(r.oob, r.misses))}</td></tr>`).join("");
}

// Same per-20 math as computeLeaderboard(), just scoped to a specific subset of one player's
// games (their games "with" vs. "without" a given teammate) instead of their whole season.
function computeRateSummaryForGames(playerId, games) {
  const totals = { pts: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 };
  const shooting = { fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0 };
  const defense = { ptsAllowed: 0, timesBeaten: 0, stops: 0 };
  let combinedPoints = 0;
  games.forEach(g => {
    const s = g.stats.find(st => st.playerId === playerId);
    if (s) STAT_FIELDS.forEach(f => totals[f] += s[f]);
    const sh = shootingStats(g, playerId);
    Object.keys(shooting).forEach(k => shooting[k] += sh[k]);
    const def = gameDefenseStats(g, playerId);
    defense.ptsAllowed += def.ptsAllowed;
    defense.timesBeaten += def.timesBeaten;
    defense.stops += def.stops;
    combinedPoints += gameTotalPoints(g);
  });
  const totalGameScore = gameScore(totals, shooting);
  const totalTwoWay = totalGameScore + defensiveImpact(defense);
  const per20 = value => combinedPoints > 0 ? (value / combinedPoints) * 20 : 0;
  return { gp: games.length, gmScorePer20: per20(totalGameScore), twoWayPer20: per20(totalTwoWay) };
}

// For each teammate this player has shared a team with (in a game with real shots logged),
// split that player's own games into "with" (teammate on their side) and "without" (teammate
// on the other team, or not playing) and compare per-20 output across the split.
function computeTeammateSynergy(playerId) {
  const qualifyingGames = state.games.filter(g => g.scoringEvents.length > 0 && (g.teamA.includes(playerId) || g.teamB.includes(playerId)));
  const teammateIds = new Set();
  qualifyingGames.forEach(g => {
    const myTeam = g.teamA.includes(playerId) ? g.teamA : g.teamB;
    myTeam.forEach(id => { if (id !== playerId) teammateIds.add(id); });
  });
  return [...teammateIds].map(teammateId => {
    const withGames = [];
    const withoutGames = [];
    qualifyingGames.forEach(g => {
      const myTeam = g.teamA.includes(playerId) ? g.teamA : g.teamB;
      (myTeam.includes(teammateId) ? withGames : withoutGames).push(g);
    });
    return {
      teammate: state.players.find(p => p.id === teammateId),
      with: computeRateSummaryForGames(playerId, withGames),
      without: computeRateSummaryForGames(playerId, withoutGames)
    };
  }).filter(r => r.teammate).sort((a, b) => b.with.gp - a.with.gp);
}

function renderTeammateSynergy(playerId) {
  const body = document.getElementById("teammateSynergyBody");
  const rows = computeTeammateSynergy(playerId);
  const fmt = (v, gp) => gp > 0 ? v.toFixed(1) : "—";
  body.innerHTML = rows.length === 0
    ? '<tr><td colspan="7" class="empty-state">No games with teammates and real shots logged yet.</td></tr>'
    : rows.map(r => `<tr><td>${escapeHtml(r.teammate.name)}</td><td>${r.with.gp}</td><td>${r.without.gp}</td><td>${fmt(r.with.gmScorePer20, r.with.gp)}</td><td>${fmt(r.without.gmScorePer20, r.without.gp)}</td><td>${fmt(r.with.twoWayPer20, r.with.gp)}</td><td>${fmt(r.without.twoWayPer20, r.without.gp)}</td></tr>`).join("");
}

function formatShootingSplitRate(m, a) {
  return a > 0 ? `${m.toFixed(1)}/${a.toFixed(1)} (${pct(m, a)}%)` : "—";
}

// Single source of truth for the Leaderboard's columns: label, how to sort it (accessor
// returning a number/string/null), and how to display it (defaults to the accessor's value).
// Keeping header + row generation driven by one list avoids them drifting out of sync.
const LEADERBOARD_COLUMNS = [
  { key: "player", label: "Player", accessor: r => r.player.name, tooltip: "Click a name to open that player's detail page." },
  { key: "gp", label: "GP", accessor: r => r.gp, tooltip: "Games with real shots logged. A game that's just been rostered but not reviewed yet doesn't count." },
  { key: "w", label: "W", accessor: r => r.wins, tooltip: "Wins, counted only for games with real shots logged." },
  { key: "l", label: "L", accessor: r => r.losses, tooltip: "Losses, counted only for games with real shots logged." },
  { key: "pct", label: "PCT", accessor: r => r.winPct, display: r => formatPct(r.winPct), tooltip: "Win percentage: wins / (wins + losses)." },
  { key: "pts", label: "PTS/20", accessor: r => r.rate.pts, display: r => r.rate.pts.toFixed(1), tooltip: "Points, per 20 combined points scored in the game (not per game — see the note above the table)." },
  { key: "fg", label: "FG", accessor: r => pct(r.shooting.fgm, r.shooting.fga), display: r => formatShootingSplitRate(r.rateShooting.fgm, r.rateShooting.fga), tooltip: "Field goals made/attempted (2s and 3s combined), per 20 combined points, with FG%." },
  { key: "tpt", label: "3PT", accessor: r => pct(r.shooting.tpm, r.shooting.tpa), display: r => formatShootingSplitRate(r.rateShooting.tpm, r.rateShooting.tpa), tooltip: "3-pointers made/attempted, per 20 combined points, with 3PT%. See the 3PT Shot Distance panel below for the Arc/Deep breakdown." },
  { key: "ft", label: "FT", accessor: r => pct(r.shooting.ftm, r.shooting.fta), display: r => formatShootingSplitRate(r.rateShooting.ftm, r.rateShooting.fta), tooltip: "Free throws made/attempted, per 20 combined points, with FT%." },
  { key: "efg", label: "eFG%", accessor: r => effectiveFgPct(r.shooting.fgm, r.shooting.tpm, r.shooting.fga), display: r => formatPct(effectiveFgPct(r.shooting.fgm, r.shooting.tpm, r.shooting.fga)), tooltip: "Effective FG% — field goal percentage weighted so a made 3 counts as 1.5 made 2s." },
  { key: "ts", label: "TS%", accessor: r => trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta), display: r => formatPct(trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta)), tooltip: "True Shooting % — overall scoring efficiency across field goals and free throws combined." },
  { key: "oreb", label: "OREB/20", accessor: r => r.rate.oreb, display: r => r.rate.oreb.toFixed(1), tooltip: "Offensive rebounds (grabbed by a teammate of the shooter), per 20 combined points." },
  { key: "dreb", label: "DREB/20", accessor: r => r.rate.dreb, display: r => r.rate.dreb.toFixed(1), tooltip: "Defensive rebounds (grabbed by an opponent of the shooter), per 20 combined points." },
  { key: "ast", label: "AST/20", accessor: r => r.rate.ast, display: r => r.rate.ast.toFixed(1), tooltip: "Assists — credited on a made shot when a teammate is tagged as the passer — per 20 combined points." },
  { key: "stl", label: "STL/20", accessor: r => r.rate.stl, display: r => r.rate.stl.toFixed(1), tooltip: "Steals, per 20 combined points." },
  { key: "blk", label: "BLK/20", accessor: r => r.rate.blk, display: r => r.rate.blk.toFixed(1), tooltip: "Blocks — credited on a missed shot when this player is tagged as the blocker — per 20 combined points." },
  { key: "tov", label: "TOV/20", accessor: r => r.rate.tov, display: r => r.rate.tov.toFixed(1), tooltip: "Turnovers (including ones forced by a steal, or a miss ruled out of bounds), per 20 combined points." },
  { key: "atov", label: "A/TO", accessor: r => r.totals.tov === 0 ? (r.totals.ast === 0 ? 0 : Infinity) : r.totals.ast / r.totals.tov, display: r => r.astTov, tooltip: "Assist-to-turnover ratio." },
  { key: "pf", label: "PF/20", accessor: r => r.rate.pf, display: r => r.rate.pf.toFixed(1), tooltip: "Personal fouls, per 20 combined points." },
  { key: "ptsAllowed", label: "Pts Allowed/20", accessor: r => r.rateDefense.ptsAllowed, display: r => r.rateDefense.ptsAllowed.toFixed(1), tooltip: "Points scored by opponents on shots where this player was the tagged defender, per 20 combined points." },
  { key: "oppfg", label: "Opp FG%", accessor: r => pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops), display: r => formatPct(pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops)), tooltip: "Shooting percentage of everyone this player was tagged defending, make or miss — a real 'shooting percentage allowed.'" },
  { key: "beaten", label: "Beaten/20", accessor: r => r.rateDefense.timesBeaten, display: r => r.rateDefense.timesBeaten.toFixed(1), tooltip: "Times scored on while tagged as the defender on a made shot, per 20 combined points." },
  { key: "stops", label: "Stops/20", accessor: r => r.rateDefense.stops, display: r => r.rateDefense.stops.toFixed(1), tooltip: "Times tagged as the defender on a missed shot, per 20 combined points." },
  { key: "defimpact", label: "Def Impact/20", accessor: r => defensiveImpact(r.rateDefense), display: r => defensiveImpact(r.rateDefense).toFixed(1), tooltip: "Stops minus Beaten minus 0.4×Pts Allowed, per 20 combined points. 0 for anyone never tagged as a defender — not a penalty for conservative tagging." },
  { key: "gmsc20", label: "GmSc/20", accessor: r => r.gameScorePer20, display: r => r.gameScorePer20.toFixed(1), tooltip: "Game Score — a single 'how good was this game' number, adapted from the standard basketball formula — per 20 combined points." },
  { key: "twoway20", label: "Two-Way/20", accessor: r => r.twoWayPer20, display: r => r.twoWayPer20.toFixed(1), tooltip: "GmSc plus Defensive Impact, per 20 combined points." },
  { key: "last5", label: "Last 5", accessor: r => r.last5GmScPer20, display: r => r.last5Gp > 0 ? `${r.last5Trend} ${r.last5GmScPer20.toFixed(1)}` : "—", tooltip: "GmSc/20 over their last 5 games with real shots logged (fewer if they haven't played 5 yet). ▲/▼ shows whether that's above or below their season GmSc/20 — within ±0.5 counts as flat (–)." }
];

let leaderboardSort = { key: "pts", dir: "desc" };

// Nulls (no attempts yet, etc.) always sort last regardless of direction.
function compareForSort(a, b, dir) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const cmp = typeof a === "string" ? a.localeCompare(b) : a - b;
  return dir === "asc" ? cmp : -cmp;
}

function renderLeaderboardHeader() {
  const headerRow = document.getElementById("leaderboardHeaderRow");
  headerRow.innerHTML = "";
  LEADERBOARD_COLUMNS.forEach(col => {
    const th = document.createElement("th");
    th.className = col.key === "player" ? "sortable-th sticky-col" : "sortable-th";
    if (col.tooltip) th.title = col.tooltip;
    const active = leaderboardSort.key === col.key;
    th.textContent = col.label + (active ? (leaderboardSort.dir === "desc" ? " ▼" : " ▲") : "");
    if (active) th.classList.add("sorted");
    th.addEventListener("click", () => {
      if (leaderboardSort.key === col.key) {
        leaderboardSort.dir = leaderboardSort.dir === "desc" ? "asc" : "desc";
      } else {
        leaderboardSort = { key: col.key, dir: "desc" };
      }
      renderLeaderboard();
    });
    headerRow.appendChild(th);
  });
}

function renderLeaderboard() {
  renderLeaderboardHeader();
  renderAwardsVsStats();
  renderLeagueHeatmap();
  renderAssistSynergy();
  renderThreePtDistancePanel();
  renderOutOfBoundsPanel();
  renderGameWinningBucketsPanel();
  const body = document.getElementById("leaderboardBody");
  body.innerHTML = "";
  // Players with no games yet just clutter the table with a row of dashes.
  const rows = computeLeaderboard().filter(r => r.gp > 0);
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="${LEADERBOARD_COLUMNS.length}" class="empty-state">No games with players yet.</td></tr>`;
    return;
  }
  const sortCol = LEADERBOARD_COLUMNS.find(c => c.key === leaderboardSort.key);
  rows.sort((a, b) => compareForSort(sortCol.accessor(a), sortCol.accessor(b), leaderboardSort.dir));

  rows.forEach(r => {
    const tr = document.createElement("tr");
    LEADERBOARD_COLUMNS.forEach(col => {
      const td = document.createElement("td");
      if (col.key === "player") {
        td.className = "sticky-col";
        const nameBtn = document.createElement("button");
        nameBtn.className = "icon-btn";
        nameBtn.style.color = "var(--accent)";
        nameBtn.style.fontWeight = "700";
        nameBtn.textContent = r.player.name;
        nameBtn.addEventListener("click", () => openPlayerDetail(r.player.id));
        td.appendChild(nameBtn);
      } else {
        td.className = "num-cell";
        td.textContent = col.display ? col.display(r) : col.accessor(r);
      }
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

// ---------- Player Detail ----------
let currentPlayerId = null;

function openPlayerDetail(playerId) {
  currentPlayerId = playerId;
  showTab("player");
  renderPlayerDetail();
}

document.getElementById("backToLeaderboardBtn").addEventListener("click", () => {
  currentPlayerId = null;
  showTab("leaderboard");
});

function renderPlayerDetail() {
  const player = state.players.find(p => p.id === currentPlayerId);
  if (!player) return;

  const row = computeLeaderboard().find(r => r.player.id === currentPlayerId);
  document.getElementById("playerDetailTitle").textContent = player.name;
  document.getElementById("playerDetailSummary").textContent = row
    ? `${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ""} · ${row.rate.pts.toFixed(1)} PTS/20 · ${row.gameScorePer20.toFixed(1)} GmSc/20 · ${row.twoWayPer20.toFixed(1)} Two-Way/20`
    : "No games yet";

  renderPlayerHeatmap(player.id);
  renderPlayerReel(player.id);
  renderPlayerGameLog(player.id);
  renderHeadToHead(player.id);
  renderTeammateSynergy(player.id);
}

// Every highlight/lowlight clip tagged to this player, across every game — the per-clip
// player tag itself is set from the Reel table in Stat Entry; this just collects them.
function renderPlayerReel(playerId) {
  const body = document.getElementById("playerReelBody");
  const clips = [];
  state.games.forEach(g => {
    g.plays.forEach(play => {
      if (play.playerId === playerId) clips.push({ ...play, gameId: g.id, gameDate: g.date });
    });
  });
  clips.sort((a, b) => (b.gameDate || "").localeCompare(a.gameDate || ""));

  if (clips.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">No clips tagged to this player yet.</td></tr>';
    return;
  }
  body.innerHTML = "";
  clips.forEach(clip => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDateDisplay(clip.gameDate)}</td>
      <td>${clip.type === "highlight" ? '<span class="badge badge-highlight">🔥 Highlight</span>' : '<span class="badge badge-lowlight">👎 Lowlight</span>'}</td>
      <td>${formatTime(clip.start)}–${formatTime(clip.end)}</td>
      <td>${escapeHtml(clip.note || "")}</td>
    `;
    const tdBtn = document.createElement("td");
    const goBtn = document.createElement("button");
    goBtn.type = "button";
    goBtn.className = "secondary-btn";
    goBtn.textContent = "Go to game";
    goBtn.addEventListener("click", () => openGame(clip.gameId));
    tdBtn.appendChild(goBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
}

function renderPlayerGameLog(playerId) {
  const body = document.getElementById("playerGameLogBody");
  body.innerHTML = "";
  const games = state.games
    .filter(g => g.teamA.includes(playerId) || g.teamB.includes(playerId))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (games.length === 0) {
    body.innerHTML = '<tr><td colspan="22" class="empty-state">No games recorded for this player yet.</td></tr>';
    return;
  }
  games.forEach(g => {
    const s = getOrCreatePlayerStats(g, playerId);
    const sh = shootingStats(g, playerId);
    const def = gameDefenseStats(g, playerId);
    const result = playerGameResult(g, playerId);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDateDisplay(g.date)}</td>
      <td>${result || "—"}</td>
      <td>${s.pts}</td>
      <td>${formatShootingSplit(sh.fgm, sh.fga)}</td>
      <td>${formatShootingSplit(sh.tpm, sh.tpa)}</td>
      <td>${formatShootingSplit(sh.ftm, sh.fta)}</td>
      <td>${formatPct(effectiveFgPct(sh.fgm, sh.tpm, sh.fga))}</td>
      <td>${formatPct(trueShootingPct(s.pts, sh.fga, sh.fta))}</td>
      <td>${s.oreb}</td>
      <td>${s.dreb}</td>
      <td>${s.ast}</td>
      <td>${s.stl}</td>
      <td>${s.blk}</td>
      <td>${s.tov}</td>
      <td>${formatAstTov(s.ast, s.tov)}</td>
      <td>${foulCellHtml(s.pf)}</td>
      <td>${def.ptsAllowed}</td>
      <td>${formatPct(def.oppFgPct)}</td>
      <td>${def.timesBeaten}</td>
      <td>${def.stops}</td>
      <td>${gameScore(s, sh).toFixed(1)}</td>
      <td>${twoWayScore(s, sh, def).toFixed(1)}</td>
    `;
    body.appendChild(tr);
  });
}

// Every shot this player took, grouped by who (if anyone) was tagged defending it. A
// double-teamed shot counts fully against each tagged defender's bucket, same as gameDefenseStats.
function headToHeadAsScorer(playerId) {
  const totals = {}; // defenderId | "none" -> { fgm, fga }
  state.games.forEach(g => {
    g.scoringEvents.filter(ev => ev.scorerId === playerId).forEach(ev => {
      const keys = (ev.defenderIds && ev.defenderIds.length > 0) ? ev.defenderIds : ["none"];
      keys.forEach(key => {
        totals[key] = totals[key] || { fgm: 0, fga: 0 };
        totals[key].fga++;
        if (ev.made !== false) totals[key].fgm++;
      });
    });
  });
  return Object.entries(totals)
    .map(([key, v]) => ({ defenderId: key === "none" ? null : key, ...v }))
    .sort((a, b) => b.fga - a.fga);
}

// Every shot this player was tagged defending, grouped by who took it.
function headToHeadAsDefender(playerId) {
  const totals = {}; // scorerId -> { fgm, fga }
  state.games.forEach(g => {
    g.scoringEvents.filter(ev => (ev.defenderIds || []).includes(playerId)).forEach(ev => {
      totals[ev.scorerId] = totals[ev.scorerId] || { fgm: 0, fga: 0 };
      totals[ev.scorerId].fga++;
      if (ev.made !== false) totals[ev.scorerId].fgm++;
    });
  });
  return Object.entries(totals)
    .map(([scorerId, v]) => ({ scorerId, ...v }))
    .sort((a, b) => b.fga - a.fga);
}

function renderHeadToHead(playerId) {
  const scorerBody = document.getElementById("h2hScorerBody");
  const scorerRows = headToHeadAsScorer(playerId);
  scorerBody.innerHTML = scorerRows.length === 0
    ? '<tr><td colspan="3" class="empty-state">No tagged shots yet.</td></tr>'
    : scorerRows.map(r => {
        const defender = r.defenderId ? state.players.find(p => p.id === r.defenderId) : null;
        return `<tr><td>${defender ? escapeHtml(defender.name) : "No defender"}</td><td>${formatShootingSplit(r.fgm, r.fga)}</td><td>${formatPct(pct(r.fgm, r.fga))}</td></tr>`;
      }).join("");

  const defenderBody = document.getElementById("h2hDefenderBody");
  const defenderRows = headToHeadAsDefender(playerId);
  defenderBody.innerHTML = defenderRows.length === 0
    ? '<tr><td colspan="3" class="empty-state">No tagged shots yet.</td></tr>'
    : defenderRows.map(r => {
        const scorer = state.players.find(p => p.id === r.scorerId);
        return `<tr><td>${scorer ? escapeHtml(scorer.name) : "?"}</td><td>${formatShootingSplit(r.fgm, r.fga)}</td><td>${formatPct(pct(r.fgm, r.fga))}</td></tr>`;
      }).join("");
}

// ---------- Export ----------
function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById("exportAllJsonBtn").addEventListener("click", () => {
  download("pool-league-data.json", JSON.stringify(state, null, 2), "application/json");
});

function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

document.getElementById("exportBoxScoreCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "team", "player", ...STAT_FIELDS,
    "fgm", "fga", "tpm", "tpa", "tp_arc_m", "tp_arc_a", "tp_deep_m", "tp_deep_a", "ftm", "fta", "efg_pct", "ts_pct", "stocks", "ast_tov",
    "pts_allowed", "opp_fg_pct", "times_beaten", "stops", "game_score", "two_way_score"]];
  state.games.forEach(game => {
    game.stats.forEach(s => {
      const player = state.players.find(p => p.id === s.playerId);
      if (!player) return;
      const teamLabel = game.teamA.includes(s.playerId) ? "A" : game.teamB.includes(s.playerId) ? "B" : "";
      const sh = shootingStats(game, s.playerId);
      const def = gameDefenseStats(game, s.playerId);
      rows.push([
        game.id, game.date, teamLabel, player.name, ...STAT_FIELDS.map(f => s[f]),
        sh.fgm, sh.fga, sh.tpm, sh.tpa, sh.tpArcM, sh.tpArcA, sh.tpDeepM, sh.tpDeepA, sh.ftm, sh.fta,
        effectiveFgPct(sh.fgm, sh.tpm, sh.fga), trueShootingPct(s.pts, sh.fga, sh.fta),
        s.stl + s.blk, formatAstTov(s.ast, s.tov),
        def.ptsAllowed, def.oppFgPct, def.timesBeaten, def.stops, gameScore(s, sh).toFixed(1), twoWayScore(s, sh, def).toFixed(1)
      ]);
    });
  });
  download("box-scores.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

// Seconds + mm:ss, matching how the Highlight Reel CSV represents timestamps — "" (not 0)
// when there's no timestamp, so it's not mistaken for an actual time at 0:00.
function videoTimeCsv(videoTime) {
  return videoTime === null || videoTime === undefined ? ["", ""] : [videoTime.toFixed(1), formatTime(videoTime)];
}

document.getElementById("exportScoringLogCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "shooter", "made", "points", "assist", "defenders", "blocked_by", "out_of_bounds_turnover", "rebounded_by", "rebound_type", "shot_x", "shot_y", "three_pt_band", "video_time_seconds", "video_time_mmss"]];
  state.games.forEach(game => {
    game.scoringEvents.forEach(ev => {
      const scorer = state.players.find(p => p.id === ev.scorerId);
      const assister = ev.assistId ? state.players.find(p => p.id === ev.assistId) : null;
      const blocker = ev.blockerId ? state.players.find(p => p.id === ev.blockerId) : null;
      const rebounder = ev.rebounderId ? state.players.find(p => p.id === ev.rebounderId) : null;
      const reboundType = rebounder ? (sameTeam(game, ev.scorerId, rebounder.id) ? "OREB" : "DREB") : "";
      const band = ev.points === 3 && ev.shotLocation ? threePtBand(ev.shotLocation) : "";
      rows.push([game.id, game.date, scorer ? scorer.name : "", ev.made !== false, ev.points, assister ? assister.name : "", defenderNames(ev.defenderIds), blocker ? blocker.name : "", !!ev.turnoverEventId, rebounder ? rebounder.name : "", reboundType, ev.shotLocation ? ev.shotLocation.x.toFixed(1) : "", ev.shotLocation ? ev.shotLocation.y.toFixed(1) : "", band, ...videoTimeCsv(ev.videoTime)]);
    });
  });
  download("shot-log.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

// Just the shots with a marked location — a focused subset of the Shot Log CSV, for handing
// Adam exactly what a shot chart needs without him having to filter out the unmapped rows
// (shot_x/shot_y are never blank here, unlike shot-log.csv).
document.getElementById("exportShotLocationsCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "player", "team", "made", "points", "shot_x", "shot_y", "video_time_seconds", "video_time_mmss"]];
  state.games.forEach(game => {
    game.scoringEvents.filter(ev => ev.shotLocation).forEach(ev => {
      const scorer = state.players.find(p => p.id === ev.scorerId);
      const team = game.teamA.includes(ev.scorerId) ? "A" : game.teamB.includes(ev.scorerId) ? "B" : "";
      rows.push([game.id, game.date, scorer ? scorer.name : "", team, ev.made !== false, ev.points, ev.shotLocation.x.toFixed(1), ev.shotLocation.y.toFixed(1), ...videoTimeCsv(ev.videoTime)]);
    });
  });
  download("shot-locations.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportOtherEventsCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "type", "player", "opponent", "via_steal", "video_time_seconds", "video_time_mmss"]];
  state.games.forEach(game => {
    TAGGED_STAT_CONFIG.forEach(cfg => {
      game[cfg.eventsKey].forEach(ev => {
        const player = state.players.find(p => p.id === ev.playerId);
        const opponent = ev.opponentId ? state.players.find(p => p.id === ev.opponentId) : null;
        const viaSteal = cfg.field === "tov" && !!ev.stealEventId;
        rows.push([game.id, game.date, cfg.verb, player ? player.name : "", opponent ? opponent.name : "", viaSteal, ...videoTimeCsv(ev.videoTime)]);
      });
    });
  });
  download("other-events.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportMatchupCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "defender", "guarded_offender", "note", "video_time_seconds", "video_time_mmss"]];
  state.games.forEach(game => {
    game.matchups.forEach(m => {
      const defender = state.players.find(p => p.id === m.defenderId);
      const offender = state.players.find(p => p.id === m.offenderId);
      rows.push([game.id, game.date, defender ? defender.name : "", offender ? offender.name : "", m.note || "", ...videoTimeCsv(m.videoTime)]);
    });
  });
  download("matchups.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportLeaderboardCsvBtn").addEventListener("click", () => {
  const rows = [["player", "games_played", ...STAT_FIELDS,
    "fgm", "fga", "tpm", "tpa", "tp_arc_m", "tp_arc_a", "tp_deep_m", "tp_deep_a", "ftm", "fta", "efg_pct", "ts_pct", "stocks", "ast_tov",
    "pts_allowed", "opp_fg_pct", "times_beaten", "stops", "pts_per_20", "game_score_per_20", "two_way_per_20"]];
  computeLeaderboard().forEach(r => {
    rows.push([
      r.player.name, r.gp, ...STAT_FIELDS.map(f => r.totals[f]),
      r.shooting.fgm, r.shooting.fga, r.shooting.tpm, r.shooting.tpa, r.shooting.tpArcM, r.shooting.tpArcA, r.shooting.tpDeepM, r.shooting.tpDeepA, r.shooting.ftm, r.shooting.fta,
      effectiveFgPct(r.shooting.fgm, r.shooting.tpm, r.shooting.fga), trueShootingPct(r.totals.pts, r.shooting.fga, r.shooting.fta),
      r.stocks, r.astTov, r.defense.ptsAllowed,
      pct(r.defense.timesBeaten, r.defense.timesBeaten + r.defense.stops),
      r.defense.timesBeaten, r.defense.stops, r.rate.pts.toFixed(1), r.gameScorePer20.toFixed(1), r.twoWayPer20.toFixed(1)
    ]);
  });
  download("leaderboard.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportAssistSynergyCsvBtn").addEventListener("click", () => {
  const rows = [["passer", "scorer", "assists"]];
  computeAssistConnections().forEach(r => {
    rows.push([r.passer.name, r.scorer.name, r.count]);
  });
  download("assist-connections.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportTeammateSynergyCsvBtn").addEventListener("click", () => {
  const rows = [["player", "teammate", "gp_with", "gp_without", "gmsc_per20_with", "gmsc_per20_without", "two_way_per20_with", "two_way_per20_without"]];
  state.players.forEach(p => {
    computeTeammateSynergy(p.id).forEach(r => {
      rows.push([
        p.name, r.teammate.name, r.with.gp, r.without.gp,
        r.with.gp > 0 ? r.with.gmScorePer20.toFixed(1) : "",
        r.without.gp > 0 ? r.without.gmScorePer20.toFixed(1) : "",
        r.with.gp > 0 ? r.with.twoWayPer20.toFixed(1) : "",
        r.without.gp > 0 ? r.without.twoWayPer20.toFixed(1) : ""
      ]);
    });
  });
  download("teammate-synergy.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportOutOfBoundsCsvBtn").addEventListener("click", () => {
  const rows = [["player", "misses", "out_of_bounds", "oob_pct"]];
  computeOutOfBoundsStats().forEach(r => {
    rows.push([r.player.name, r.misses, r.oob, pct(r.oob, r.misses) ?? ""]);
  });
  download("out-of-bounds.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

document.getElementById("exportReelCsvBtn").addEventListener("click", () => {
  const rows = [["game_id", "date", "type", "start_seconds", "start_mmss", "end_seconds", "end_mmss", "player", "note"]];
  state.games.forEach(game => {
    (game.plays || []).forEach(play => {
      const player = play.playerId ? state.players.find(p => p.id === play.playerId) : null;
      rows.push([
        game.id, game.date, play.type,
        play.start.toFixed(1), formatTime(play.start),
        play.end.toFixed(1), formatTime(play.end),
        player ? player.name : "", play.note || ""
      ]);
    });
  });
  download("highlight-reel.csv", rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
});

function renderExportGameSelect() {
  const sel = document.getElementById("exportGameSelect");
  sel.innerHTML = [...state.games].sort((x, y) => (x.date || "").localeCompare(y.date || ""))
    .map(g => `<option value="${g.id}">${formatDateDisplay(g.date)} (${g.teamA.length + g.teamB.length} players)</option>`).join("");
}

document.getElementById("exportGameJsonBtn").addEventListener("click", () => {
  const gameId = document.getElementById("exportGameSelect").value;
  const game = state.games.find(g => g.id === gameId);
  if (!game) return;
  // A single-game export has no sibling `masterVideos` array to resolve `masterVideoId`
  // against (unlike the full "export all data" dump, where it's a top-level array) — without
  // this, fileName never actually reaches anyone reading just this one file.
  const masterVideo = game.masterVideoId ? (state.masterVideos.find(m => m.id === game.masterVideoId) || null) : null;
  download(`game-${gameId}.json`, JSON.stringify({ ...game, masterVideo }, null, 2), "application/json");
});

// Loads whatever video a game actually has (session video, local file, or a direct link — not
// YouTube, which can't be seeked programmatically) into the given wrap, independent of
// currentGameId/currentVideoEl so it doesn't disturb Stat Entry's own video state. Shares the
// same blob URL caches as the main flow, so a game already opened this session loads instantly
// instead of re-reading IndexedDB.
async function loadBackfillVideo(game, videoWrap) {
  let url = null;
  if (game.masterVideoId) {
    url = masterVideoBlobUrls[game.masterVideoId];
    if (!url) {
      const file = await getVideoFile(game.masterVideoId);
      if (file) { url = URL.createObjectURL(file); masterVideoBlobUrls[game.masterVideoId] = url; }
    }
  } else {
    url = localVideoBlobUrls[game.id];
    if (!url) {
      const file = await getVideoFile(game.id);
      if (file) { url = URL.createObjectURL(file); localVideoBlobUrls[game.id] = url; }
    }
  }
  if (!url && game.videoUrl && /\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(game.videoUrl)) url = game.videoUrl;
  if (!videoWrap.isConnected) return; // panel moved on before this resolved — nothing to update
  if (url) {
    videoWrap.innerHTML = `<video controls class="backfill-video"></video>`;
    videoWrap.querySelector("video").src = url;
  } else {
    videoWrap.innerHTML = '<p class="hint" style="margin:0">No video available for this game — mark from memory, or open it directly in Stat Entry.</p>';
  }
}

let backfillUndoTimer = null;

// A few seconds' grace to fix a misclick without hunting back through the list for it —
// clicking Undo puts the shot right back to whatever it was before this click (null if it was
// unmarked, or its previous spot if you were correcting an already-marked one).
function showBackfillUndoToast(playerName, game, eventId, previousLocation) {
  const toast = document.getElementById("backfillUndoToast");
  if (!toast) return;
  clearTimeout(backfillUndoTimer);
  toast.innerHTML = `<span class="hint" style="margin:0">Location set for ${escapeHtml(playerName)}'s shot.</span> <button type="button" class="icon-btn" data-undo-location="1">Undo</button>`;
  toast.querySelector("[data-undo-location]").addEventListener("click", () => {
    const ev = game.scoringEvents.find(e => e.id === eventId);
    if (ev) ev.shotLocation = previousLocation;
    saveState();
    clearTimeout(backfillUndoTimer);
    renderBackfillShotLocations();
  });
  backfillUndoTimer = setTimeout(() => { toast.innerHTML = ""; }, 8000);
}

function setShotChartDot(svgEl, location) {
  const existing = svgEl.querySelector(".shot-chart-dot");
  if (existing) existing.remove();
  if (!location) return;
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", shotChartVbX(location.x));
  dot.setAttribute("cy", shotChartVbY(location.y));
  dot.setAttribute("r", "4");
  dot.setAttribute("class", "shot-chart-dot");
  svgEl.appendChild(dot);
}

// Off by default so the list only shows what's actually missing — the satisfying "clear the
// list" case. Toggling it on reveals already-marked shots too (with their dot shown), for
// fixing a mistaken spot without needing to remember which specific shot it was.
let backfillShowMarked = false;

// Backfilling shot locations for games logged before the shot chart existed — grouped by game,
// each group with its own video (loaded once, reused for every shot in that game) so a shot can
// actually be placed correctly instead of guessed at from memory. In the default (missing-only)
// view, a click removes just that one row from the DOM rather than re-rendering the whole
// panel, so every other group's video keeps playing undisturbed — the same reason the main
// video panel avoids tearing its <video> down on every re-render. With "show already-marked"
// on, a click instead redraws that row's dot in place, since the row needs to stay visible
// either way. Undo always does a full re-render, since it's rare enough that losing another
// group's playback position is an acceptable trade for simpler code.
function renderBackfillShotLocations() {
  const wrap = document.getElementById("backfillShotLocations");
  if (!wrap) return;
  const gamesWithShots = state.games
    .map(game => {
      const allFg = game.scoringEvents.filter(ev => ev.points === 2 || ev.points === 3);
      const missing = allFg.filter(ev => !ev.shotLocation);
      return { game, shots: backfillShowMarked ? allFg : missing, missingCount: missing.length };
    })
    .filter(({ shots }) => shots.length > 0)
    .sort((a, b) => (a.game.date || "").localeCompare(b.game.date || ""));

  const totalMissing = gamesWithShots.reduce((sum, { missingCount }) => sum + missingCount, 0);
  const toggleHtml = `<label class="hint" style="display:flex;align-items:center;gap:6px;margin:0 0 10px">
    <input type="checkbox" id="backfillShowMarkedToggle" ${backfillShowMarked ? "checked" : ""}>
    Show already-marked shots too (to fix a mistaken one)
  </label>`;

  if (gamesWithShots.length === 0) {
    wrap.innerHTML = toggleHtml + '<p class="empty-state">Every field goal has a shot location. Nothing to backfill.</p>';
    wrap.querySelector("#backfillShowMarkedToggle").addEventListener("change", e => {
      backfillShowMarked = e.target.checked;
      renderBackfillShotLocations();
    });
    return;
  }

  wrap.innerHTML = toggleHtml +
    `<p class="hint backfill-summary" style="margin-top:0">${totalMissing} shot${totalMissing === 1 ? "" : "s"} still missing a location.</p><div id="backfillUndoToast"></div>`;
  wrap.querySelector("#backfillShowMarkedToggle").addEventListener("change", e => {
    backfillShowMarked = e.target.checked;
    renderBackfillShotLocations();
  });
  const summaryEl = wrap.querySelector(".backfill-summary");

  gamesWithShots.forEach(({ game, shots }) => {
    const groupEl = document.createElement("div");
    groupEl.className = "backfill-game-group";
    groupEl.innerHTML = `<h4>${escapeHtml(formatDateDisplay(game.date))}</h4><div class="backfill-video-wrap"><p class="hint" style="margin:0">Loading video…</p></div>`;
    const videoWrap = groupEl.querySelector(".backfill-video-wrap");

    const rowsEl = document.createElement("div");
    rowsEl.className = "backfill-shot-rows";
    shots.forEach(ev => {
      const scorer = state.players.find(p => p.id === ev.scorerId);
      const hasTime = ev.videoTime !== null && ev.videoTime !== undefined;
      const row = document.createElement("div");
      row.className = ev.shotLocation ? "backfill-shot-row backfill-shot-row-marked" : "backfill-shot-row";
      row.innerHTML = `
        <div class="backfill-shot-label">
          ${scorer ? escapeHtml(scorer.name) : "?"} — ${ev.made !== false ? "Make" : "Miss"} (${ev.points}pt)
        </div>
        <button type="button" class="secondary-btn" data-watch="1" ${hasTime ? "" : "disabled"}>▶ Watch</button>
        ${renderShotChartBaseSvg("data-shot-chart")}
      `;
      setShotChartDot(row.querySelector("[data-shot-chart]"), ev.shotLocation);
      row.querySelector("[data-watch]").addEventListener("click", () => {
        const video = videoWrap.querySelector("video");
        if (!video || !hasTime) return;
        video.currentTime = ev.videoTime;
        video.play();
      });
      row.querySelector("[data-shot-chart]").addEventListener("click", e => {
        const rect = e.currentTarget.getBoundingClientRect();
        const previousLocation = ev.shotLocation;
        const xFrac = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
        const yFrac = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
        // Flipped rendering (hoop at the bottom) — invert back to the stored convention.
        ev.shotLocation = { x: xFrac, y: 100 - yFrac };
        saveState();
        // Order matters: show the toast (which needs #backfillUndoToast intact) before doing
        // any cleanup that might otherwise be tempted to wipe the whole panel.
        showBackfillUndoToast(scorer ? scorer.name : "?", game, ev.id, previousLocation);

        if (backfillShowMarked) {
          // The row stays either way in this mode — just redraw its dot.
          setShotChartDot(e.currentTarget, ev.shotLocation);
          row.classList.add("backfill-shot-row-marked");
          if (!previousLocation) {
            const left = Math.max(0, parseInt(summaryEl.textContent, 10) - 1);
            summaryEl.textContent = `${left} shot${left === 1 ? "" : "s"} still missing a location.`;
          }
          return;
        }
        row.remove();
        if (!rowsEl.querySelector(".backfill-shot-row")) groupEl.remove();
        const left = Math.max(0, parseInt(summaryEl.textContent, 10) - 1);
        if (left <= 0) {
          summaryEl.textContent = "";
          if (!wrap.querySelector(".backfill-done-msg")) {
            const doneMsg = document.createElement("p");
            doneMsg.className = "empty-state backfill-done-msg";
            doneMsg.textContent = "Every field goal has a shot location. Nothing to backfill.";
            wrap.appendChild(doneMsg);
          }
        } else {
          summaryEl.textContent = `${left} shot${left === 1 ? "" : "s"} still missing a location.`;
        }
      });
      rowsEl.appendChild(row);
    });
    groupEl.appendChild(rowsEl);
    wrap.appendChild(groupEl);
    // Only load the video once the group is actually attached to the live DOM — otherwise a
    // cached blob URL resolves synchronously, before appendChild above has run, and the
    // `videoWrap.isConnected` guard in loadBackfillVideo silently bails, leaving "Loading
    // video…" stuck forever. An uncached load only surfaced this by accident: the IndexedDB
    // round-trip is slow enough that the DOM always catches up first.
    loadBackfillVideo(game, videoWrap);
  });
}

// Every marked 2PT/3PT shot where the spot disagrees with the point value picked at logging
// time — the same mismatch the Shot Log's "📍 2PT range"/"📍 3PT range" badge flags one row at
// a time (see renderScoringLog), collected here so a whole season's worth can be reviewed in
// one pass instead of stumbled onto while scrolling. Free throws never have a location, so
// they're never candidates.
function computeFlaggedShotMismatches() {
  const flagged = [];
  state.games.forEach(game => {
    game.scoringEvents.forEach(ev => {
      if (!ev.shotLocation || (ev.points !== 2 && ev.points !== 3)) return;
      const zone = ev.shotLocation.y >= 60 ? 3 : 2;
      if (zone !== ev.points) flagged.push({ game, ev });
    });
  });
  return flagged;
}

let flaggedUndoTimer = null;

// Same grace-period Undo as Backfill's — puts a re-marked shot's location right back to
// wherever it was before this click.
function showFlaggedUndoToast(playerName, game, eventId, previousLocation) {
  const toast = document.getElementById("flaggedShotUndoToast");
  if (!toast) return;
  clearTimeout(flaggedUndoTimer);
  toast.innerHTML = `<span class="hint" style="margin:0">Location updated for ${escapeHtml(playerName)}'s shot.</span> <button type="button" class="icon-btn" data-undo-location="1">Undo</button>`;
  toast.querySelector("[data-undo-location]").addEventListener("click", () => {
    const ev = game.scoringEvents.find(e => e.id === eventId);
    if (ev) ev.shotLocation = previousLocation;
    saveState();
    clearTimeout(flaggedUndoTimer);
    renderFlaggedShotMismatches();
  });
  flaggedUndoTimer = setTimeout(() => { toast.innerHTML = ""; }, 8000);
}

// Grouped by game, same shape and video-loading approach as Backfill Shot Locations — each
// group loads its own video once so a shot can be re-marked against the actual play instead of
// from memory. Re-marking a shot that then agrees with its point value drops it from the list,
// the same "click removes just that row" pattern Backfill uses so other groups' video playback
// isn't disturbed; re-marking to a spot that's still flagged just redraws the dot in place.
function renderFlaggedShotMismatches() {
  const wrap = document.getElementById("flaggedShotMismatches");
  if (!wrap) return;
  const flagged = computeFlaggedShotMismatches();
  const byGame = {};
  flagged.forEach(({ game, ev }) => {
    (byGame[game.id] = byGame[game.id] || { game, shots: [] }).shots.push(ev);
  });
  const groups = Object.values(byGame).sort((a, b) => (a.game.date || "").localeCompare(b.game.date || ""));

  if (groups.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No flagged shots — every marked 2PT/3PT location agrees with its point value.</p>';
    return;
  }

  wrap.innerHTML = `<p class="hint flagged-summary" style="margin-top:0">${flagged.length} shot${flagged.length === 1 ? "" : "s"} flagged.</p><div id="flaggedShotUndoToast"></div>`;
  const summaryEl = wrap.querySelector(".flagged-summary");

  groups.forEach(({ game, shots }) => {
    const groupEl = document.createElement("div");
    groupEl.className = "backfill-game-group";
    groupEl.innerHTML = `<h4>${escapeHtml(formatDateDisplay(game.date))}</h4><div class="backfill-video-wrap"><p class="hint" style="margin:0">Loading video…</p></div>`;
    const videoWrap = groupEl.querySelector(".backfill-video-wrap");

    const rowsEl = document.createElement("div");
    rowsEl.className = "backfill-shot-rows";
    shots.forEach(ev => {
      const scorer = state.players.find(p => p.id === ev.scorerId);
      const hasTime = ev.videoTime !== null && ev.videoTime !== undefined;
      const zoneLabel = ev.shotLocation.y >= 60 ? "3PT range" : "2PT range";
      const row = document.createElement("div");
      row.className = "backfill-shot-row backfill-shot-row-marked";
      row.innerHTML = `
        <div class="backfill-shot-label">
          ${scorer ? escapeHtml(scorer.name) : "?"} — picked ${ev.points}pt, marked at 📍 ${zoneLabel}
        </div>
        <button type="button" class="secondary-btn" data-watch="1" ${hasTime ? "" : "disabled"}>▶ Watch</button>
        ${renderShotChartBaseSvg("data-shot-chart")}
      `;
      setShotChartDot(row.querySelector("[data-shot-chart]"), ev.shotLocation);
      row.querySelector("[data-watch]").addEventListener("click", () => {
        const video = videoWrap.querySelector("video");
        if (!video || !hasTime) return;
        video.currentTime = ev.videoTime;
        video.play();
      });
      row.querySelector("[data-shot-chart]").addEventListener("click", e => {
        const rect = e.currentTarget.getBoundingClientRect();
        const previousLocation = ev.shotLocation;
        const xFrac = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
        const yFrac = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
        ev.shotLocation = { x: xFrac, y: 100 - yFrac };
        saveState();
        showFlaggedUndoToast(scorer ? scorer.name : "?", game, ev.id, previousLocation);

        const stillFlagged = (ev.shotLocation.y >= 60 ? 3 : 2) !== ev.points;
        if (stillFlagged) {
          setShotChartDot(e.currentTarget, ev.shotLocation);
          return;
        }
        row.remove();
        if (!rowsEl.querySelector(".backfill-shot-row")) groupEl.remove();
        const left = Math.max(0, parseInt(summaryEl.textContent, 10) - 1);
        if (left <= 0) {
          summaryEl.textContent = "";
          if (!wrap.querySelector(".flagged-done-msg")) {
            const doneMsg = document.createElement("p");
            doneMsg.className = "empty-state flagged-done-msg";
            doneMsg.textContent = "No flagged shots — every marked 2PT/3PT location agrees with its point value.";
            wrap.appendChild(doneMsg);
          }
        } else {
          summaryEl.textContent = `${left} shot${left === 1 ? "" : "s"} flagged.`;
        }
      });
      rowsEl.appendChild(row);
    });
    groupEl.appendChild(rowsEl);
    wrap.appendChild(groupEl);
    loadBackfillVideo(game, videoWrap);
  });
}

// A game's masterVideoId can go stale without anything in the tracker ever erroring — the
// video panel just falls back to "no video" behavior, which looks like a game that was never
// given a video rather than one whose reference broke. Surfacing this list is the only way to
// notice, since nothing else about using the app would ever reveal it.
function renderBrokenVideoLinks() {
  const wrap = document.getElementById("brokenVideoLinks");
  if (!wrap) return;
  const broken = state.games
    .filter(g => g.masterVideoId && !state.masterVideos.some(m => m.id === g.masterVideoId))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (broken.length === 0) {
    wrap.innerHTML = '<p class="empty-state">No broken session video links found.</p>';
    return;
  }
  const table = document.createElement("table");
  table.className = "matchup-table";
  table.innerHTML = `<thead><tr><th>Game</th><th>Broken reference</th><th></th></tr></thead><tbody></tbody>`;
  const body = table.querySelector("tbody");
  broken.forEach(game => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(formatDateDisplay(game.date))}</td><td><code>${escapeHtml(game.masterVideoId)}</code></td>`;
    const tdBtn = document.createElement("td");
    const fixBtn = document.createElement("button");
    fixBtn.type = "button";
    fixBtn.className = "secondary-btn";
    fixBtn.textContent = "Open in Stat Entry to fix";
    fixBtn.addEventListener("click", () => openGame(game.id));
    tdBtn.appendChild(fixBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function renderMasterVideoList() {
  const body = document.getElementById("masterVideoListBody");
  if (!body) return;
  body.innerHTML = "";
  if (state.masterVideos.length === 0) {
    body.innerHTML = '<tr><td colspan="3" class="empty-state">No session videos uploaded yet.</td></tr>';
    return;
  }
  state.masterVideos.forEach(m => {
    const usedByCount = state.games.filter(g => g.masterVideoId === m.id).length;
    const tr = document.createElement("tr");
    const fileNameHint = m.fileName ? ` <span class="hint" style="margin:0">(${escapeHtml(m.fileName)})</span>` : "";
    tr.innerHTML = `<td>${escapeHtml(m.name)}${fileNameHint}</td><td>${usedByCount} game${usedByCount === 1 ? "" : "s"}</td>`;
    const tdBtn = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Remove "${m.name}"? This clears it from ${usedByCount} game${usedByCount === 1 ? "" : "s"} using it.`)) return;
      state.games.forEach(g => {
        if (g.masterVideoId === m.id) { g.masterVideoId = null; g.videoStart = 0; }
      });
      state.masterVideos = state.masterVideos.filter(mv => mv.id !== m.id);
      if (masterVideoBlobUrls[m.id]) {
        URL.revokeObjectURL(masterVideoBlobUrls[m.id]);
        delete masterVideoBlobUrls[m.id];
      }
      await deleteVideoFile(m.id);
      saveState();
      renderMasterVideoList();
      renderGames();
    });
    tdBtn.appendChild(delBtn);
    tr.appendChild(tdBtn);
    body.appendChild(tr);
  });
}

document.getElementById("importFileInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!imported.players || !imported.games) throw new Error("Missing expected fields");
      if (!confirm("This will replace all current data with the imported file. Continue?")) return;
      state = imported;
      state.masterVideos = state.masterVideos || [];
      (state.games || []).forEach(normalizeGame);
      saveState();
      renderPlayers();
      renderGames();
      showTab("players");
    } catch (err) {
      alert("Could not import file: " + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});

document.getElementById("resetDataBtn").addEventListener("click", () => {
  if (!confirm("This will permanently delete all players, games, and stats. Continue?")) return;
  state = { players: [], games: [], masterVideos: [] };
  saveState();
  renderPlayers();
  renderGames();
});

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------- Init ----------
renderPlayers();
renderGames();

// Land back on whatever was in view last time, instead of always resetting to Games — a
// browser refresh (or just reopening the file) shouldn't feel like navigating to a new page.
(function restoreLastView() {
  let ui = null;
  try { ui = JSON.parse(localStorage.getItem(UI_STATE_KEY)); } catch (e) { /* corrupt/missing, ignore */ }
  if (ui && ui.tab === "stats" && ui.gameId && state.games.some(g => g.id === ui.gameId)) {
    openGame(ui.gameId);
  } else if (ui && ui.tab === "player" && ui.playerId && state.players.some(p => p.id === ui.playerId)) {
    openPlayerDetail(ui.playerId);
  } else if (ui && ["players", "games", "leaderboard", "export"].includes(ui.tab)) {
    showTab(ui.tab);
  } else {
    showTab("games");
  }
})();
