"use strict";

/* ---------------------------------------------------------------------
 * Config
 * ------------------------------------------------------------------- */

const API_BASE = "https://overfast-api.tekrop.fr";
const HISTORY_URL = "data/history.json";

const PLAYERS = [
  { key: "skipp", battletag: "Skipp#2133", id: "Skipp-2133", varName: "--series-1", shadeVar: "--series-1-shade2" },
  { key: "looloobaa", battletag: "Looloobaa#2250", id: "Looloobaa-2250", varName: "--series-2", shadeVar: "--series-2-shade2" },
];

const ROLES = [
  { key: "tank", label: "Tank" },
  { key: "damage", label: "Damage" },
  { key: "support", label: "Support" },
];

const DIVISIONS = [
  "bronze", "silver", "gold", "platinum", "emerald",
  "diamond", "master", "grandmaster", "ultimate",
];
const TIERS_PER_DIVISION = 5;

const CHALLENGE_START = new Date("2026-08-19T00:00:00Z");
const CHALLENGE_END = new Date("2026-09-13T23:59:59Z");

let heroesMetaCache = null;
let latestHistory = [];
let heroTabPlayerKey = PLAYERS[0].key;
let statsHeroPlayerKey = PLAYERS[0].key;
let heroStatsLookback = "challenge";
const heroPlaytimeSelected = {}; // playerKey -> heroKey

/* ---------------------------------------------------------------------
 * Rank helpers
 * ------------------------------------------------------------------- */

function divisionLabel(division) {
  if (!division) return "";
  return division.charAt(0).toUpperCase() + division.slice(1);
}

function rankScore(entry) {
  if (!entry || !entry.division) return null;
  const idx = DIVISIONS.indexOf(entry.division);
  if (idx === -1) return null;
  const tier = entry.tier || 1;
  return idx * TIERS_PER_DIVISION + (TIERS_PER_DIVISION - tier + 1);
}

function divisionIndexOfScore(score) {
  return Math.floor((score - 1) / TIERS_PER_DIVISION);
}

function rankText(entry) {
  if (!entry || !entry.division) return "Unranked";
  const div = divisionLabel(entry.division);
  return entry.tier ? `${div} ${entry.tier}` : div;
}

// Picks the highest-scoring role out of tank/damage/support for a
// {tank, damage, support} competitive object. Returns null if unranked everywhere.
function highestRank(competitive) {
  if (!competitive) return null;
  let best = null;
  for (const role of ROLES) {
    const entry = competitive[role.key];
    const score = rankScore(entry);
    if (score !== null && (!best || score > best.score)) {
      best = { roleLabel: role.label, roleIcon: entry.role_icon, entry, score };
    }
  }
  return best;
}

// Scans every tracked snapshot for a player and returns the single
// highest-scoring rank ever recorded (the "peak"), independent of what
// their current rank is.
function computePeakRank(history, playerKey) {
  let best = null;
  history.forEach((entry) => {
    const pdata = entry.players?.[playerKey];
    if (!pdata || !pdata.ok) return;
    const current = highestRank(pdata.competitive);
    if (current && (!best || current.score > best.score)) best = current;
  });
  return best;
}

/* ---------------------------------------------------------------------
 * Formatting helpers
 * ------------------------------------------------------------------- */

function fmtDate(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateShort(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtDateTime(d) {
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtInt(n) {
  return n === null || n === undefined ? "—" : Math.round(n).toLocaleString();
}
function fmtAvg(n) {
  return n === null || n === undefined ? "—" : n.toFixed(1);
}
function fmtPct(n) {
  return n === null || n === undefined ? "—" : `${Math.round(n)}%`;
}
function fmtDuration(seconds) {
  if (!seconds) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function isoDate(d) { return d.toISOString().slice(0, 10); }

// "Nice" round number at or above v, for axis tops.
function niceMax(v) {
  if (v <= 0) return 4;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * mag;
}

/* ---------------------------------------------------------------------
 * Fetching
 * ------------------------------------------------------------------- */

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body?.error?.message || body?.error?.error || `HTTP ${res.status}`;
    const reason = res.status === 404 ? "not_found" : (/private/i.test(message) ? "private" : "error");
    throw Object.assign(new Error(message), { reason });
  }
  return res.json();
}

async function loadLivePlayer(p) {
  try {
    const [summary, careerStats] = await Promise.all([
      fetchJson(`${API_BASE}/players/${encodeURIComponent(p.id)}/summary`),
      fetchJson(`${API_BASE}/players/${encodeURIComponent(p.id)}/stats/career?gamemode=competitive&platform=pc`),
    ]);
    return {
      battletag: p.battletag,
      ok: true,
      username: summary.username,
      avatar: summary.avatar,
      endorsement: summary.endorsement?.level ?? null,
      competitive: summary.competitive?.pc ?? null,
      career_stats: careerStats,
    };
  } catch (err) {
    return { battletag: p.battletag, ok: false, reason: err.reason || "error", message: err.message };
  }
}

async function loadHeroesMeta() {
  if (heroesMetaCache) return heroesMetaCache;
  try {
    const list = await fetchJson(`${API_BASE}/heroes`);
    const map = {};
    for (const h of list) map[h.key] = h;
    heroesMetaCache = map;
  } catch {
    heroesMetaCache = {};
  }
  return heroesMetaCache;
}

async function loadHistory() {
  try {
    const res = await fetch(HISTORY_URL, { cache: "no-store" });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// Per-player day-by-day delta of a cumulative career stat. The first
// tracked day always has delta 0 (we don't front-load the season's
// pre-tracking total onto day one) — every following point is the
// change since the previous *tracked* day (gaps from a private/failed
// fetch don't reset the baseline).
function dailySeries(history, playerKey, getValue) {
  const points = [];
  let prev = null;
  history.forEach((entry) => {
    const pdata = entry.players?.[playerKey];
    if (!pdata || !pdata.ok) return;
    const value = getValue(pdata);
    if (value === null || value === undefined) return;
    const delta = prev === null ? 0 : Math.max(0, value - prev);
    points.push({ date: new Date(entry.date + "T12:00:00Z"), delta, value });
    prev = value;
  });
  return points;
}

// Same idea as dailySeries, but as a single before/after delta rather than
// a per-day series: value at the latest tracked snapshot minus the value at
// the latest snapshot on or before sinceDate (clamped to the earliest data
// available if sinceDate is before tracking began).
function playerValueSeries(history, playerKey, getValue) {
  const points = [];
  history.forEach((entry) => {
    const pdata = entry.players?.[playerKey];
    if (!pdata || !pdata.ok) return;
    const value = getValue(pdata);
    if (value === null || value === undefined) return;
    points.push({ date: new Date(entry.date + "T12:00:00Z"), value });
  });
  return points;
}

function deltaSince(history, playerKey, sinceDate, getValue) {
  const points = playerValueSeries(history, playerKey, getValue);
  if (points.length === 0) return null;
  const latest = points[points.length - 1].value;
  let baseline = points[0].value;
  for (const pt of points) {
    if (pt.date <= sinceDate) baseline = pt.value; else break;
  }
  return Math.max(0, latest - baseline);
}

function lookbackCutoffDate(mode) {
  if (mode === "challenge") return CHALLENGE_START;
  return new Date(Date.now() - Number(mode) * 86400000);
}

/* ---------------------------------------------------------------------
 * Challenge progress
 * ------------------------------------------------------------------- */

function renderChallengeProgress() {
  const now = new Date();
  const total = CHALLENGE_END - CHALLENGE_START;
  const elapsed = now - CHALLENGE_START;
  const pct = clamp((elapsed / total) * 100, 0, 100);

  document.getElementById("date-start").textContent = fmtDate(CHALLENGE_START);
  document.getElementById("date-end").textContent = fmtDate(CHALLENGE_END);
  document.getElementById("challenge-progress-fill").style.width = `${pct}%`;

  const statusEl = document.getElementById("challenge-status");
  if (now < CHALLENGE_START) {
    const days = Math.ceil((CHALLENGE_START - now) / 86400000);
    statusEl.textContent = `Starts in ${days} day${days === 1 ? "" : "s"}`;
  } else if (now > CHALLENGE_END) {
    statusEl.textContent = "Challenge ended";
  } else {
    const dayNum = Math.floor((now - CHALLENGE_START) / 86400000) + 1;
    const daysLeft = Math.ceil((CHALLENGE_END - now) / 86400000);
    statusEl.textContent = `Day ${dayNum} — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
  }
}

/* ---------------------------------------------------------------------
 * Player cards (highest rank only)
 * ------------------------------------------------------------------- */

function renderPlayerCards(players) {
  const section = document.getElementById("players-section");
  section.innerHTML = "";

  players.forEach((p) => {
    const card = document.createElement("div");
    card.className = "player-card";

    if (!p.ok) {
      const friendlyReason = p.reason === "not_found"
        ? "No public profile found for this BattleTag."
        : p.reason === "private"
          ? "This profile is set to private."
          : "Couldn't load this profile right now.";
      card.innerHTML = `
        <div class="player-card-head">
          <span class="player-swatch" style="background:var(${p.varName})"></span>
          <div class="player-identity">
            <p class="player-name">${p.battletag.split("#")[0]}</p>
            <p class="player-tag">${p.battletag}</p>
          </div>
        </div>
        <p class="player-card-empty">${friendlyReason}</p>
      `;
      section.appendChild(card);
      return;
    }

    const d = p;
    const current = highestRank(d.competitive);
    const best = computePeakRank(latestHistory, p.key);

    card.innerHTML = `
      <div class="player-card-head">
        <img class="player-avatar" src="${d.avatar || ""}" alt="" />
        <div class="player-identity">
          <p class="player-name"><span class="player-swatch" style="background:var(${p.varName})"></span>${d.username || p.battletag}</p>
          <p class="player-tag">${p.battletag}${d.endorsement ? " · Endorsement " + d.endorsement : ""}</p>
        </div>
      </div>
      ${current ? `
        <div class="player-peak">
          <img class="player-peak-icon" src="${current.entry.rank_icon || current.entry.tier_icon}" alt="${rankText(current.entry)}" />
          <div>
            <p class="player-peak-division">${rankText(current.entry)}</p>
            <p class="player-peak-role">${current.roleIcon ? `<img src="${current.roleIcon}" alt="" />` : ""}${current.roleLabel}</p>
            ${best ? `<p class="player-peak-best">Peak: ${rankText(best.entry)}</p>` : ""}
          </div>
        </div>
      ` : `<p class="player-card-empty">Unranked this season</p>`}
    `;
    section.appendChild(card);
  });
}

function renderLegend(players, elementId) {
  const legend = document.getElementById(elementId);
  legend.innerHTML = players.map((p) => `
    <span class="legend-item">
      <span class="legend-swatch" style="background:var(${p.varName})"></span>
      ${p.battletag.split("#")[0]}
    </span>
  `).join("");
}

/* ---------------------------------------------------------------------
 * Shared chart plumbing (tooltip + hover-line wiring)
 * ------------------------------------------------------------------- */

function wireHover(container, viewW, viewH, onEnter) {
  const svg = container.querySelector("svg");
  const tooltip = container.querySelector(".cw-tooltip");
  const hoverLine = container.querySelector(".cw-hover-line");
  container.querySelectorAll(".cw-hit").forEach((strip) => {
    strip.addEventListener("mouseenter", () => {
      const rect = svg.getBoundingClientRect();
      const scaleX = rect.width / viewW;
      const scaleY = rect.height / viewH;
      onEnter(strip, { tooltip, hoverLine, scaleX, scaleY });
    });
    strip.addEventListener("mouseleave", () => {
      if (hoverLine) hoverLine.style.opacity = "0";
      tooltip.style.opacity = "0";
    });
  });
}

function placeTooltip(tooltip, xUnits, yUnits, scaleX, scaleY, html) {
  tooltip.innerHTML = html;
  tooltip.style.left = `${xUnits * scaleX}px`;
  tooltip.style.top = `${yUnits * scaleY}px`;
  tooltip.style.opacity = "1";
}

/* ---------------------------------------------------------------------
 * Overview tab: rank-over-time line chart
 * ------------------------------------------------------------------- */

const RC_W = 1100, RC_H = 400;
const RC_MARGIN = { top: 16, right: 70, bottom: 36, left: 150 };
const RC_PLOT_W = RC_W - RC_MARGIN.left - RC_MARGIN.right;
const RC_PLOT_H = RC_H - RC_MARGIN.top - RC_MARGIN.bottom;

function rcX(date) {
  const t = clamp((date - CHALLENGE_START) / (CHALLENGE_END - CHALLENGE_START), 0, 1);
  return RC_MARGIN.left + t * RC_PLOT_W;
}

function buildRankSeries(history, players) {
  const series = {};
  players.forEach((p) => { series[p.key] = []; });
  history.forEach((entry) => {
    const date = new Date(entry.date + "T12:00:00Z");
    players.forEach((p) => {
      const pdata = entry.players?.[p.key];
      if (!pdata || !pdata.ok) return;
      const peak = highestRank(pdata.competitive);
      if (!peak) return;
      series[p.key].push({ date, score: peak.score, label: rankText(peak.entry), roleLabel: peak.roleLabel });
    });
  });
  players.forEach((p) => series[p.key].sort((a, b) => a.date - b.date));
  return series;
}

// Zooms the y-axis to one division below the lowest achieved rank through
// one division above the highest, instead of the full Bronze-to-Champion span.
function computeRankYDomain(series, players) {
  let minScore = null, maxScore = null;
  players.forEach((p) => {
    series[p.key].forEach((pt) => {
      if (minScore === null || pt.score < minScore) minScore = pt.score;
      if (maxScore === null || pt.score > maxScore) maxScore = pt.score;
    });
  });
  if (minScore === null) { minScore = 11; maxScore = 15; } // fallback: around Gold
  const minDiv = clamp(divisionIndexOfScore(minScore) - 1, 0, DIVISIONS.length - 1);
  const maxDiv = clamp(divisionIndexOfScore(maxScore) + 1, 0, DIVISIONS.length - 1);
  return { minDiv, maxDiv, yMin: minDiv * TIERS_PER_DIVISION, yMax: (maxDiv + 1) * TIERS_PER_DIVISION };
}

function renderLineChart(history, players) {
  const container = document.getElementById("line-chart");
  const series = buildRankSeries(history, players);
  const { minDiv, maxDiv, yMin, yMax } = computeRankYDomain(series, players);

  function rcY(score) {
    return RC_MARGIN.top + RC_PLOT_H - ((clamp(score, yMin, yMax) - yMin) / (yMax - yMin)) * RC_PLOT_H;
  }

  // Y axis: one gridline per sub-rank (tier), division name once per band.
  let yAxis = "";
  for (let div = minDiv; div <= maxDiv; div++) {
    const bandTop = div * TIERS_PER_DIVISION + TIERS_PER_DIVISION;
    const bandBottom = div * TIERS_PER_DIVISION;
    for (let tier = TIERS_PER_DIVISION; tier >= 1; tier--) {
      const scoreAtTierTop = div * TIERS_PER_DIVISION + (TIERS_PER_DIVISION - tier + 1);
      const y = rcY(scoreAtTierTop);
      yAxis += `<line class="cw-gridline-minor" x1="${RC_MARGIN.left}" x2="${RC_MARGIN.left + RC_PLOT_W}" y1="${y}" y2="${y}" />`;
      yAxis += `<text class="cw-axis-label-minor" x="${RC_MARGIN.left - 16}" y="${y}" text-anchor="end" dominant-baseline="middle">${tier}</text>`;
    }
    yAxis += `<line class="cw-gridline" x1="${RC_MARGIN.left}" x2="${RC_MARGIN.left + RC_PLOT_W}" y1="${rcY(bandTop)}" y2="${rcY(bandTop)}" />`;
    const bandMidY = (rcY(bandTop) + rcY(bandBottom)) / 2;
    yAxis += `<text class="cw-axis-label" x="${RC_MARGIN.left - 48}" y="${bandMidY}" text-anchor="end" dominant-baseline="middle">${divisionLabel(DIVISIONS[div])}</text>`;
  }
  yAxis += `<line class="cw-gridline" x1="${RC_MARGIN.left}" x2="${RC_MARGIN.left + RC_PLOT_W}" y1="${rcY(yMin)}" y2="${rcY(yMin)}" />`;

  // X axis: every day, anchored to the same noon-UTC instant used for data
  // points so ticks line up exactly with the dots/lines above them.
  let dateLabels = "";
  let firstTick = true;
  for (let d = new Date(CHALLENGE_START); d <= CHALLENGE_END; d.setUTCDate(d.getUTCDate() + 1)) {
    const noon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
    const x = rcX(noon);
    const label = (firstTick || noon.getUTCDate() === 1) ? fmtDateShort(noon) : String(noon.getUTCDate());
    dateLabels += `<text class="cw-date-label" x="${x}" y="${RC_H - 10}" text-anchor="middle">${label}</text>`;
    firstTick = false;
  }

  const lines = players.map((p) => {
    const pts = series[p.key];
    if (pts.length === 0) return "";
    const pointsAttr = pts.map((pt) => `${rcX(pt.date)},${rcY(pt.score)}`).join(" ");
    const dots = pts.map((pt) => `<circle class="cw-dot" cx="${rcX(pt.date)}" cy="${rcY(pt.score)}" r="4.5" fill="var(${p.varName})" />`).join("");
    const last = pts[pts.length - 1];
    const endLabel = `
      <circle cx="${rcX(last.date) + 12}" cy="${rcY(last.score)}" r="3.5" fill="var(${p.varName})" />
      <text class="cw-end-label" x="${rcX(last.date) + 20}" y="${rcY(last.score)}" dominant-baseline="middle" fill="var(--text-primary)">${last.label}</text>
    `;
    return `
      <polyline class="cw-line" points="${pointsAttr}" stroke="var(${p.varName})" />
      ${dots}
      ${endLabel}
    `;
  }).join("");

  const allDates = [...new Set(players.flatMap((p) => series[p.key].map((pt) => isoDate(pt.date))))].sort();
  const hits = allDates.map((iso, i) => {
    const d = new Date(iso + "T12:00:00Z");
    const x = rcX(d);
    const prevX = i > 0 ? rcX(new Date(allDates[i - 1] + "T12:00:00Z")) : RC_MARGIN.left;
    const nextX = i < allDates.length - 1 ? rcX(new Date(allDates[i + 1] + "T12:00:00Z")) : RC_MARGIN.left + RC_PLOT_W;
    const left = (prevX + x) / 2, right = (x + nextX) / 2;
    return `<rect class="cw-hit" data-date="${iso}" x="${left}" y="${RC_MARGIN.top}" width="${Math.max(1, right - left)}" height="${RC_PLOT_H}" fill="transparent" />`;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${RC_W} ${RC_H}" preserveAspectRatio="xMidYMid meet">
      ${yAxis}
      ${dateLabels}
      ${lines}
      <line class="cw-hover-line" x1="0" x2="0" y1="${RC_MARGIN.top}" y2="${RC_MARGIN.top + RC_PLOT_H}" />
      ${hits}
    </svg>
    <div class="cw-tooltip"></div>
  `;

  wireHover(container, RC_W, RC_H, (strip, { tooltip, hoverLine, scaleX, scaleY }) => {
    const iso = strip.getAttribute("data-date");
    const date = new Date(iso + "T12:00:00Z");
    const x = rcX(date);
    hoverLine.setAttribute("x1", x);
    hoverLine.setAttribute("x2", x);
    hoverLine.style.opacity = "1";

    const rows = players.map((p) => {
      const pt = series[p.key].find((s) => isoDate(s.date) === iso);
      if (!pt) return "";
      return `<div class="cw-tooltip-row"><span class="cw-tooltip-swatch" style="background:var(${p.varName})"></span>${p.battletag.split("#")[0]}: ${pt.label} <span class="cw-tooltip-sub">(${pt.roleLabel})</span></div>`;
    }).join("");
    placeTooltip(tooltip, x, RC_MARGIN.top - 8, scaleX, scaleY, `<div class="cw-tooltip-date">${fmtDate(date)}</div>${rows}`);
  });
}

/* ---------------------------------------------------------------------
 * Overview tab: games played per day (stacked win/loss, grouped by player)
 * ------------------------------------------------------------------- */

const GC_W = 1100, GC_H = 320;
const GC_MARGIN = { top: 14, right: 20, bottom: 38, left: 50 };
const GC_PLOT_W = GC_W - GC_MARGIN.left - GC_MARGIN.right;
const GC_PLOT_H = GC_H - GC_MARGIN.top - GC_MARGIN.bottom;

function buildDailyGamesData(history, players) {
  const perPlayer = {};
  players.forEach((p) => {
    const gamesPts = dailySeries(history, p.key, (pd) => pd.career_stats?.["all-heroes"]?.game?.games_played ?? null);
    const winsPts = dailySeries(history, p.key, (pd) => pd.career_stats?.["all-heroes"]?.game?.games_won ?? null);
    const winsByDate = new Map(winsPts.map((pt) => [isoDate(pt.date), pt.delta]));
    perPlayer[p.key] = gamesPts.map((pt) => {
      const iso = isoDate(pt.date);
      const wins = winsByDate.get(iso) ?? 0;
      const games = pt.delta;
      const losses = Math.max(0, games - wins);
      return { date: pt.date, games, wins, losses };
    });
  });
  const dateSet = new Set();
  players.forEach((p) => perPlayer[p.key].forEach((pt) => dateSet.add(isoDate(pt.date))));
  const dates = [...dateSet].sort().map((iso) => new Date(iso + "T12:00:00Z"));
  return { dates, perPlayer };
}

function renderGamesChart(history, players) {
  const container = document.getElementById("games-chart");
  const { dates, perPlayer } = buildDailyGamesData(history, players);

  if (dates.length < 2) {
    container.innerHTML = `<p class="empty-note">Only one day tracked so far — day-by-day changes need at least two tracked days to compare. Check back tomorrow.</p>`;
    return;
  }

  const maxGames = Math.max(1, ...players.flatMap((p) => perPlayer[p.key].map((d) => d.games)));
  const yMax = niceMax(maxGames);
  const dayW = GC_PLOT_W / dates.length;
  const barW = Math.min(24, dayW * 0.32);
  const groupGap = 3;

  function yPix(v) { return GC_MARGIN.top + GC_PLOT_H - (v / yMax) * GC_PLOT_H; }

  const stepCount = Math.min(5, yMax);
  const step = yMax / stepCount;
  let yAxis = "";
  for (let i = 0; i <= stepCount; i++) {
    const v = i * step;
    const y = yPix(v);
    yAxis += `<line class="cw-gridline${i === 0 ? "" : "-minor"}" x1="${GC_MARGIN.left}" x2="${GC_MARGIN.left + GC_PLOT_W}" y1="${y}" y2="${y}" />`;
    yAxis += `<text class="cw-axis-label-minor" x="${GC_MARGIN.left - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${Math.round(v)}</text>`;
  }

  let bars = "", dateLabels = "", hits = "";
  let firstTick = true;
  dates.forEach((date, i) => {
    const iso = isoDate(date);
    const cx = GC_MARGIN.left + i * dayW + dayW / 2;
    const groupW = barW * players.length + groupGap * (players.length - 1);
    let x = cx - groupW / 2;
    const baseY = yPix(0);

    players.forEach((p) => {
      const pt = perPlayer[p.key].find((d) => isoDate(d.date) === iso);
      const wins = pt?.wins ?? 0;
      const losses = pt?.losses ?? 0;
      if (wins > 0) {
        const winsTopY = yPix(wins);
        bars += `<rect class="cw-bar" x="${x}" y="${winsTopY}" width="${barW}" height="${Math.max(0, baseY - winsTopY)}" rx="3" fill="var(${p.varName})" />`;
      }
      if (losses > 0) {
        const winsTopY = yPix(wins);
        const lossesTopY = yPix(wins + losses);
        const gap = wins > 0 ? 2 : 0;
        bars += `<rect class="cw-bar" x="${x}" y="${lossesTopY}" width="${barW}" height="${Math.max(0, winsTopY - lossesTopY - gap)}" rx="3" fill="var(${p.shadeVar})" />`;
      }
      x += barW + groupGap;
    });

    const label = (firstTick || date.getUTCDate() === 1) ? fmtDateShort(date) : String(date.getUTCDate());
    dateLabels += `<text class="cw-date-label" x="${cx}" y="${GC_H - 12}" text-anchor="middle">${label}</text>`;
    hits += `<rect class="cw-hit" data-date="${iso}" x="${GC_MARGIN.left + i * dayW}" y="${GC_MARGIN.top}" width="${dayW}" height="${GC_PLOT_H}" fill="transparent" />`;
    firstTick = false;
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${GC_W} ${GC_H}" preserveAspectRatio="xMidYMid meet">
      ${yAxis}
      ${dateLabels}
      ${bars}
      <line class="cw-hover-line" x1="0" x2="0" y1="${GC_MARGIN.top}" y2="${GC_MARGIN.top + GC_PLOT_H}" />
      ${hits}
    </svg>
    <div class="cw-tooltip"></div>
  `;

  wireHover(container, GC_W, GC_H, (strip, { tooltip, hoverLine, scaleX, scaleY }) => {
    const iso = strip.getAttribute("data-date");
    const x = parseFloat(strip.getAttribute("x")) + parseFloat(strip.getAttribute("width")) / 2;
    hoverLine.setAttribute("x1", x);
    hoverLine.setAttribute("x2", x);
    hoverLine.style.opacity = "1";

    const rows = players.map((p) => {
      const pt = perPlayer[p.key].find((d) => isoDate(d.date) === iso);
      const games = pt?.games ?? 0, wins = pt?.wins ?? 0, losses = pt?.losses ?? 0;
      return `<div class="cw-tooltip-row"><span class="cw-tooltip-swatch" style="background:var(${p.varName})"></span>${p.battletag.split("#")[0]}: ${games} game${games === 1 ? "" : "s"} <span class="cw-tooltip-sub">(${wins}W–${losses}L)</span></div>`;
    }).join("");
    placeTooltip(tooltip, x, GC_MARGIN.top - 8, scaleX, scaleY, `<div class="cw-tooltip-date">${fmtDate(new Date(iso + "T12:00:00Z"))}</div>${rows}`);
  });
}

/* ---------------------------------------------------------------------
 * Sortable data tables (shared by Stats + Heroes tables)
 * ------------------------------------------------------------------- */

function sortRows(rows, sortState) {
  if (!sortState.key) return rows;
  const indexed = rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    const va = a.r[sortState.key], vb = b.r[sortState.key];
    const aNull = va === null || va === undefined;
    const bNull = vb === null || vb === undefined;
    if (aNull && bNull) return a.i - b.i;
    if (aNull) return 1;
    if (bNull) return -1;
    let cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    if (cmp === 0) cmp = a.i - b.i;
    return sortState.dir === "asc" ? cmp : -cmp;
  });
  return indexed.map((x) => x.r);
}

function updateSortIndicators(theadSelector, sortState) {
  document.querySelectorAll(`${theadSelector} th[data-sort-key]`).forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.getAttribute("data-sort-key") === sortState.key) {
      th.classList.add(sortState.dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

function wireSortableHeaders(theadSelector, sortState, onChange) {
  document.querySelectorAll(`${theadSelector} th[data-sort-key]`).forEach((th) => {
    th.classList.add("is-sortable");
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort-key");
      const type = th.getAttribute("data-sort-type") || "number";
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.key = key;
        sortState.dir = type === "text" ? "asc" : "desc";
      }
      updateSortIndicators(theadSelector, sortState);
      onChange();
    });
  });
  updateSortIndicators(theadSelector, sortState);
}

/* ---------------------------------------------------------------------
 * Stats tab
 * ------------------------------------------------------------------- */

function computeStatsRow(careerStats) {
  const all = careerStats?.["all-heroes"];
  if (!all) return null;
  const games = all.game?.games_played ?? 0;
  const won = all.game?.games_won ?? 0;
  const elims = all.combat?.eliminations ?? null;
  const dmg = all.combat?.hero_damage_done ?? all.combat?.damage_done ?? null;
  const deaths = all.combat?.deaths ?? null;

  return {
    games,
    winPct: games > 0 ? (won / games) * 100 : null,
    avgElims: games > 0 && elims !== null ? elims / games : null,
    avgDmg: games > 0 && dmg !== null ? dmg / games : null,
    avgDeaths: games > 0 && deaths !== null ? deaths / games : null,
    mostElims: all.best?.eliminations_most_in_game ?? null,
    mostDmg: all.best?.hero_damage_done_most_in_game ?? all.best?.all_damage_done_most_in_game ?? null,
  };
}

const statsSortState = { key: null, dir: "desc" };
let lastStatsRows = [];

function renderStatsTab(players) {
  lastStatsRows = players.map((p) => {
    const row = p.ok ? computeStatsRow(p.career_stats) : null;
    return {
      playerRef: p,
      player: p.battletag.split("#")[0],
      games: row?.games ?? null,
      winPct: row?.winPct ?? null,
      avgElims: row?.avgElims ?? null,
      avgDmg: row?.avgDmg ?? null,
      avgDeaths: row?.avgDeaths ?? null,
      mostElims: row?.mostElims ?? null,
      mostDmg: row?.mostDmg ?? null,
      unavailable: !p.ok,
      empty: p.ok && (!row || row.games === 0),
    };
  });
  renderStatsTableBody();
}

function renderStatsTableBody() {
  const body = document.getElementById("stats-table-body");
  const sorted = sortRows(lastStatsRows, statsSortState);
  body.innerHTML = sorted.map((r) => {
    if (r.unavailable) {
      return `<tr><td class="cell-player"><span class="player-swatch" style="background:var(${r.playerRef.varName})"></span>${r.player}</td><td colspan="7" class="cell-muted">profile unavailable</td></tr>`;
    }
    if (r.empty) {
      return `<tr><td class="cell-player"><span class="player-swatch" style="background:var(${r.playerRef.varName})"></span>${r.player}</td><td colspan="7" class="cell-muted">no competitive games played this season</td></tr>`;
    }
    return `
      <tr>
        <td class="cell-player"><span class="player-swatch" style="background:var(${r.playerRef.varName})"></span>${r.player}</td>
        <td>${fmtInt(r.games)}</td>
        <td>${fmtPct(r.winPct)}</td>
        <td>${fmtAvg(r.avgElims)}</td>
        <td>${fmtInt(r.avgDmg)}</td>
        <td>${fmtAvg(r.avgDeaths)}</td>
        <td>${fmtInt(r.mostElims)}</td>
        <td>${fmtInt(r.mostDmg)}</td>
      </tr>
    `;
  }).join("");
}

/* ---------------------------------------------------------------------
 * Stats tab: hero stats since challenge start
 * ------------------------------------------------------------------- */

// Time played / games / win% are counted only since sinceDate (a delta off
// the tracked snapshots) — season-long history from before that doesn't
// count. Avg elims/dmg/deaths can't be isolated to a window without
// match-by-match data, so those stay as the season-wide per-game averages
// the API actually gives us.
function heroRows(careerStats, heroesMeta, playerKey, sinceDate) {
  if (!careerStats) return [];
  return Object.entries(careerStats)
    .filter(([key]) => key !== "all-heroes")
    .map(([key, cat]) => {
      const seasonTimePlayed = cat.game?.time_played ?? 0;
      if (seasonTimePlayed <= 0) return null;
      const seasonGames = cat.game?.games_played ?? 0;
      const elims = cat.combat?.eliminations ?? null;
      const dmg = cat.combat?.hero_damage_done ?? cat.combat?.all_damage_done ?? null;
      const deaths = cat.combat?.deaths ?? null;

      const timeDelta = deltaSince(latestHistory, playerKey, sinceDate, (pd) => pd.career_stats?.[key]?.game?.time_played ?? 0) ?? 0;
      const gamesDelta = deltaSince(latestHistory, playerKey, sinceDate, (pd) => pd.career_stats?.[key]?.game?.games_played ?? 0) ?? 0;
      const winsDelta = deltaSince(latestHistory, playerKey, sinceDate, (pd) => pd.career_stats?.[key]?.game?.games_won ?? 0) ?? 0;

      const meta = heroesMeta[key];
      return {
        key,
        name: meta?.name || key,
        portrait: meta?.portrait || "",
        role: meta?.role ? meta.role.charAt(0).toUpperCase() + meta.role.slice(1) : "—",
        timePlayed: timeDelta,
        games: gamesDelta,
        winPct: gamesDelta > 0 ? (winsDelta / gamesDelta) * 100 : null,
        avgElims: seasonGames > 0 && elims !== null ? elims / seasonGames : null,
        avgDmg: seasonGames > 0 && dmg !== null ? dmg / seasonGames : null,
        avgDeaths: seasonGames > 0 && deaths !== null ? deaths / seasonGames : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.timePlayed - a.timePlayed);
}

function computeAllHeroesRow(active, sinceDate) {
  const seasonRow = computeStatsRow(active.career_stats);
  const timeDelta = deltaSince(latestHistory, active.key, sinceDate, (pd) => pd.career_stats?.["all-heroes"]?.game?.time_played ?? null) ?? 0;
  const gamesDelta = deltaSince(latestHistory, active.key, sinceDate, (pd) => pd.career_stats?.["all-heroes"]?.game?.games_played ?? null) ?? 0;
  const winsDelta = deltaSince(latestHistory, active.key, sinceDate, (pd) => pd.career_stats?.["all-heroes"]?.game?.games_won ?? null) ?? 0;
  return {
    key: "__all__",
    name: "All",
    portrait: "",
    role: "—",
    timePlayed: timeDelta,
    games: gamesDelta,
    winPct: gamesDelta > 0 ? (winsDelta / gamesDelta) * 100 : null,
    avgElims: seasonRow?.avgElims ?? null,
    avgDmg: seasonRow?.avgDmg ?? null,
    avgDeaths: seasonRow?.avgDeaths ?? null,
  };
}

const heroesSortState = { key: "timePlayed", dir: "desc" };
let lastHeroRows = [];
let lastHeroAllRow = null;
let lastHeroMaxTime = 0;
let lastHeroActivePlayer = null;

function renderChallengeHeroTable(active, heroesMeta) {
  lastHeroActivePlayer = active;
  const emptyNote = document.getElementById("heroes-empty");
  const sinceDate = lookbackCutoffDate(heroStatsLookback);

  if (!active || !active.ok) {
    lastHeroRows = [];
    lastHeroAllRow = null;
    document.getElementById("heroes-table-body").innerHTML = "";
    emptyNote.hidden = false;
    emptyNote.textContent = "Profile unavailable for this player.";
    return;
  }
  lastHeroRows = heroRows(active.career_stats, heroesMeta, active.key, sinceDate);
  lastHeroAllRow = computeAllHeroesRow(active, sinceDate);
  if (lastHeroRows.length === 0) {
    document.getElementById("heroes-table-body").innerHTML = "";
    emptyNote.hidden = false;
    emptyNote.textContent = "No competitive hero data this season yet.";
    return;
  }
  if (latestHistory.length < 2) {
    emptyNote.hidden = false;
    emptyNote.textContent = "Only one day tracked so far, so time/games/win % below read zero — they need at least two tracked days to show a change. Check back tomorrow.";
  } else {
    emptyNote.hidden = true;
  }
  lastHeroMaxTime = Math.max(1, ...lastHeroRows.map((r) => r.timePlayed));
  renderHeroesTableBody();
}

function renderHeroesTableBody() {
  const body = document.getElementById("heroes-table-body");
  const sorted = sortRows(lastHeroRows, heroesSortState);
  const allRowHtml = lastHeroAllRow ? `
    <tr class="row-total">
      <td class="cell-hero">${lastHeroAllRow.name}</td>
      <td>${lastHeroAllRow.role}</td>
      <td>${fmtDuration(lastHeroAllRow.timePlayed)}</td>
      <td>${fmtInt(lastHeroAllRow.games)}</td>
      <td>${fmtPct(lastHeroAllRow.winPct)}</td>
      <td>${fmtAvg(lastHeroAllRow.avgElims)}</td>
      <td>${fmtInt(lastHeroAllRow.avgDmg)}</td>
      <td>${fmtAvg(lastHeroAllRow.avgDeaths)}</td>
    </tr>
  ` : "";
  const heroRowsHtml = sorted.map((r) => {
    const pct = clamp((r.timePlayed / lastHeroMaxTime) * 100, 0, 100);
    return `
    <tr>
      <td class="cell-hero">${r.portrait ? `<img src="${r.portrait}" alt="" />` : ""}${r.name}</td>
      <td>${r.role}</td>
      <td>
        <div class="time-bar-track">
          <div class="time-bar-fill" style="width:${pct}%;background:var(${lastHeroActivePlayer.varName})">
            <span class="time-bar-label">${fmtDuration(r.timePlayed)}</span>
          </div>
        </div>
      </td>
      <td>${fmtInt(r.games)}</td>
      <td>${fmtPct(r.winPct)}</td>
      <td>${fmtAvg(r.avgElims)}</td>
      <td>${fmtInt(r.avgDmg)}</td>
      <td>${fmtAvg(r.avgDeaths)}</td>
    </tr>
  `;
  }).join("");
  body.innerHTML = allRowHtml + heroRowsHtml;
}

/* ---------------------------------------------------------------------
 * Heroes tab: hero playtime-per-day chart
 * ------------------------------------------------------------------- */

const HC_W = 1100, HC_H = 300;
const HC_MARGIN = { top: 14, right: 20, bottom: 34, left: 58 };
const HC_PLOT_W = HC_W - HC_MARGIN.left - HC_MARGIN.right;
const HC_PLOT_H = HC_H - HC_MARGIN.top - HC_MARGIN.bottom;

function renderHeroPlaytimeChart(container, playerEntry, pts) {
  if (pts.length === 0) {
    container.innerHTML = "";
    return;
  }
  const maxSeconds = Math.max(60, ...pts.map((p) => p.delta));
  const yMaxMinutes = niceMax(Math.ceil(maxSeconds / 60));
  const yMax = yMaxMinutes * 60;
  const dayW = HC_PLOT_W / pts.length;
  const barW = Math.min(28, dayW * 0.55);

  function yPix(v) { return HC_MARGIN.top + HC_PLOT_H - (v / yMax) * HC_PLOT_H; }

  const stepCount = Math.min(5, yMaxMinutes);
  const step = yMaxMinutes / stepCount;
  let yAxis = "";
  for (let i = 0; i <= stepCount; i++) {
    const vMin = i * step;
    const y = yPix(vMin * 60);
    yAxis += `<line class="cw-gridline${i === 0 ? "" : "-minor"}" x1="${HC_MARGIN.left}" x2="${HC_MARGIN.left + HC_PLOT_W}" y1="${y}" y2="${y}" />`;
    yAxis += `<text class="cw-axis-label-minor" x="${HC_MARGIN.left - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${Math.round(vMin)}m</text>`;
  }

  let bars = "", dateLabels = "", hits = "";
  const baseY = yPix(0);
  let firstTick = true;
  pts.forEach((pt, i) => {
    const cx = HC_MARGIN.left + i * dayW + dayW / 2;
    const x = cx - barW / 2;
    if (pt.delta > 0) {
      const topY = yPix(pt.delta);
      bars += `<rect class="cw-bar" x="${x}" y="${topY}" width="${barW}" height="${Math.max(0, baseY - topY)}" rx="3" fill="var(${playerEntry.varName})" />`;
    }
    const label = (firstTick || pt.date.getUTCDate() === 1) ? fmtDateShort(pt.date) : String(pt.date.getUTCDate());
    dateLabels += `<text class="cw-date-label" x="${cx}" y="${HC_H - 10}" text-anchor="middle">${label}</text>`;
    hits += `<rect class="cw-hit" data-i="${i}" x="${HC_MARGIN.left + i * dayW}" y="${HC_MARGIN.top}" width="${dayW}" height="${HC_PLOT_H}" fill="transparent" />`;
    firstTick = false;
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${HC_W} ${HC_H}" preserveAspectRatio="xMidYMid meet">
      ${yAxis}
      ${dateLabels}
      ${bars}
      <line class="cw-hover-line" x1="0" x2="0" y1="${HC_MARGIN.top}" y2="${HC_MARGIN.top + HC_PLOT_H}" />
      ${hits}
    </svg>
    <div class="cw-tooltip"></div>
  `;

  wireHover(container, HC_W, HC_H, (strip, { tooltip, hoverLine, scaleX, scaleY }) => {
    const i = parseInt(strip.getAttribute("data-i"), 10);
    const pt = pts[i];
    const cx = HC_MARGIN.left + i * dayW + dayW / 2;
    hoverLine.setAttribute("x1", cx);
    hoverLine.setAttribute("x2", cx);
    hoverLine.style.opacity = "1";
    const row = `<div class="cw-tooltip-row"><span class="cw-tooltip-swatch" style="background:var(${playerEntry.varName})"></span>${fmtDuration(pt.delta)}</div>`;
    placeTooltip(tooltip, cx, HC_MARGIN.top - 8, scaleX, scaleY, `<div class="cw-tooltip-date">${fmtDate(pt.date)}</div>${row}`);
  });
}

function renderHeroPlaytimeSection(playerEntry, heroesMeta) {
  const subtabsEl = document.getElementById("hero-subtabs");
  const chartEl = document.getElementById("hero-playtime-chart");
  const emptyEl = document.getElementById("hero-playtime-empty");

  if (!playerEntry || !playerEntry.ok) {
    subtabsEl.innerHTML = "";
    chartEl.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = "Profile unavailable for this player.";
    return;
  }

  const heroKeys = Object.keys(playerEntry.career_stats || {}).filter((k) => k !== "all-heroes");
  const candidates = heroKeys
    .map((key) => {
      const pts = dailySeries(latestHistory, playerEntry.key, (pd) => pd.career_stats?.[key]?.game?.time_played ?? 0);
      const total = pts.reduce((s, pt) => s + pt.delta, 0);
      return { key, pts, total };
    })
    .filter((h) => h.total > 0)
    .sort((a, b) => b.total - a.total);

  if (candidates.length === 0) {
    subtabsEl.innerHTML = "";
    chartEl.innerHTML = "";
    emptyEl.hidden = false;
    emptyEl.textContent = latestHistory.length < 2
      ? "Need at least two tracked days to show daily playtime — check back tomorrow."
      : "No tracked hero playtime yet during the challenge.";
    return;
  }
  emptyEl.hidden = true;

  if (!heroPlaytimeSelected[playerEntry.key] || !candidates.find((c) => c.key === heroPlaytimeSelected[playerEntry.key])) {
    heroPlaytimeSelected[playerEntry.key] = candidates[0].key;
  }
  const selectedKey = heroPlaytimeSelected[playerEntry.key];

  subtabsEl.innerHTML = candidates.map((c) => {
    const meta = heroesMeta[c.key];
    return `<button type="button" data-hero="${c.key}" class="${c.key === selectedKey ? "is-active" : ""}">
      ${meta?.portrait ? `<img src="${meta.portrait}" alt="" />` : ""}${meta?.name || c.key}
    </button>`;
  }).join("");
  subtabsEl.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      heroPlaytimeSelected[playerEntry.key] = btn.getAttribute("data-hero");
      renderHeroPlaytimeSection(playerEntry, heroesMeta);
    });
  });

  const selected = candidates.find((c) => c.key === selectedKey);
  renderHeroPlaytimeChart(chartEl, playerEntry, selected.pts);
}

/* ---------------------------------------------------------------------
 * Heroes tab: player switch + orchestration
 * ------------------------------------------------------------------- */

function renderHeroPlayerSwitch(players) {
  const el = document.getElementById("hero-player-switch");
  el.innerHTML = players.map((p) => `
    <button type="button" data-key="${p.key}" class="${p.key === heroTabPlayerKey ? "is-active" : ""}" style="${p.key === heroTabPlayerKey ? `color:var(${p.varName})` : ""}">
      <span class="legend-swatch" style="background:var(${p.varName})"></span>${p.battletag.split("#")[0]}
    </button>
  `).join("");
  el.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      heroTabPlayerKey = btn.getAttribute("data-key");
      renderHeroesTab(currentPlayers);
    });
  });
}

let currentPlayers = [];

async function renderHeroesTab(players) {
  currentPlayers = players;
  renderHeroPlayerSwitch(players);
  const heroesMeta = await loadHeroesMeta();
  const active = players.find((p) => p.key === heroTabPlayerKey);
  renderHeroPlaytimeSection(active, heroesMeta);
}

function renderStatsHeroPlayerSwitch(players) {
  const el = document.getElementById("stats-hero-player-switch");
  el.innerHTML = players.map((p) => `
    <button type="button" data-key="${p.key}" class="${p.key === statsHeroPlayerKey ? "is-active" : ""}" style="${p.key === statsHeroPlayerKey ? `color:var(${p.varName})` : ""}">
      <span class="legend-swatch" style="background:var(${p.varName})"></span>${p.battletag.split("#")[0]}
    </button>
  `).join("");
  el.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      statsHeroPlayerKey = btn.getAttribute("data-key");
      renderStatsHeroSection(currentPlayers);
    });
  });
}

async function renderStatsHeroSection(players) {
  renderStatsHeroPlayerSwitch(players);
  const heroesMeta = await loadHeroesMeta();
  const active = players.find((p) => p.key === statsHeroPlayerKey);
  renderChallengeHeroTable(active, heroesMeta);
}

/* ---------------------------------------------------------------------
 * Tabs
 * ------------------------------------------------------------------- */

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-selected", "true");

      const target = btn.getAttribute("data-tab");
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.hidden = panel.id !== `panel-${target}`;
      });
    });
  });
}

/* ---------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------- */

async function refresh() {
  const btn = document.getElementById("refresh-btn");
  btn.classList.add("spinning");
  btn.disabled = true;

  try {
    const [liveResults, history] = await Promise.all([
      Promise.all(PLAYERS.map((p) => loadLivePlayer(p))),
      loadHistory(),
    ]);

    const players = PLAYERS.map((p, i) => ({ ...p, ...liveResults[i] }));

    // Merge today's live snapshot into the history used for the charts, so
    // they reach "now" even between nightly GitHub Actions collections.
    const todayIso = isoDate(new Date());
    const mergedHistory = history.filter((h) => h.date !== todayIso).concat([{
      date: todayIso,
      collected_at: new Date().toISOString(),
      players: Object.fromEntries(players.map((p) => [p.key, p])),
    }]).sort((a, b) => a.date.localeCompare(b.date));

    latestHistory = mergedHistory;

    renderPlayerCards(players);
    renderLegend(players, "rank-legend");
    renderLegend(players, "games-legend");
    renderLineChart(mergedHistory, players);
    renderGamesChart(mergedHistory, players);
    renderStatsTab(players);
    await renderHeroesTab(players);
    await renderStatsHeroSection(players);

    const trackingSince = history.length > 0
      ? ` · Tracking since ${fmtDate(new Date(history[0].date + "T12:00:00Z"))}`
      : "";
    document.getElementById("last-checked").textContent = `Last checked: ${fmtDateTime(new Date())}${trackingSince}`;
  } catch (err) {
    document.getElementById("last-checked").textContent = `Refresh failed: ${err.message}`;
  } finally {
    btn.classList.remove("spinning");
    btn.disabled = false;
  }
}

document.getElementById("refresh-btn").addEventListener("click", refresh);

document.getElementById("hero-stats-lookback").addEventListener("change", (e) => {
  heroStatsLookback = e.target.value;
  renderStatsHeroSection(currentPlayers);
});

wireTabs();
wireSortableHeaders("#stats-table thead", statsSortState, renderStatsTableBody);
wireSortableHeaders("#heroes-table thead", heroesSortState, renderHeroesTableBody);
renderChallengeProgress();
setInterval(renderChallengeProgress, 60_000);
refresh();
