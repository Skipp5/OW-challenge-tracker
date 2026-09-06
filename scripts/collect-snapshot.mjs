// Fetches current OverFast API stats for both players. Upserts today's
// entry (CEST calendar date) into data/history.json — one entry per day,
// holding both the day's frozen opening value and its continuously-updated
// current value, so each day's own delta (current minus opening) is
// self-contained and doesn't depend on neighboring days. Separately appends
// to data/rank_history.json, but only when a player's rank actually changed
// since the last recorded entry — rank isn't cumulative (it can go up and
// back down within a day), so catching that requires an actual observation
// at the moment of change, not just a periodic snapshot. Run on a schedule
// via GitHub Actions.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = "https://overfast-api.tekrop.fr";
const HISTORY_PATH = path.join(__dirname, "..", "data", "history.json");
const RANK_HISTORY_PATH = path.join(__dirname, "..", "data", "rank_history.json");

// The collector is scheduled to run at 22:00 UTC specifically because that's
// midnight CEST — but 22:00 UTC is still the *previous* UTC calendar date, so
// labeling by raw UTC date would make the nightly run overwrite today's entry
// instead of starting tomorrow's. Shift by the CEST offset before slicing so
// the date label matches the calendar day that's actually starting.
const CEST_OFFSET_MS = 2 * 60 * 60 * 1000;
function cestDate(date) {
  return new Date(date.getTime() + CEST_OFFSET_MS).toISOString().slice(0, 10);
}

const PLAYERS = [
  { key: "skipp", battletag: "Skipp#2133", id: "Skipp-2133" },
  { key: "looloobaa", battletag: "Looloobaa#2250", id: "Looloobaa-2250" },
];

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body?.error?.message || body?.error?.error || `HTTP ${res.status}`;
    const reason = res.status === 404
      ? "not_found"
      : /private/i.test(message) ? "private" : "error";
    const err = new Error(message);
    err.reason = reason;
    throw err;
  }
  return body;
}

async function collectPlayer(p) {
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
    console.error(`[${p.battletag}] fetch failed: ${err.message}`);
    return { battletag: p.battletag, ok: false, reason: err.reason || "error", message: err.message };
  }
}

// Order-independent structural equality — JSON.stringify comparison isn't
// safe here because OverFast doesn't guarantee stable key ordering between
// requests, so semantically identical rank data can serialize differently
// and falsely look like a change.
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual(a[key], b[key]));
}

async function readJsonSafe(filePath, label) {
  try {
    const raw = (await readFile(filePath, "utf8")).replace(/^﻿/, ""); // strip BOM if present
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Could not read/parse existing ${label}, starting fresh: ${err.message}`);
    return [];
  }
}

async function main() {
  await mkdir(path.dirname(HISTORY_PATH), { recursive: true });

  const history = await readJsonSafe(HISTORY_PATH, "history.json");
  const rankHistory = await readJsonSafe(RANK_HISTORY_PATH, "rank_history.json");

  const today = cestDate(new Date());
  const players = {};
  for (const p of PLAYERS) {
    players[p.key] = await collectPlayer(p);
  }

  // opening_players is frozen at the first *successful* poll of the day and
  // never touched again — it's the anchor "how many games did today add" is
  // measured against. players reflects the latest successful poll (or,
  // once the day is over, its final value). A failed fetch (OverFast
  // 5xx/timeout — this happens) must never overwrite either field with
  // failure data; that would permanently corrupt the day. Instead it's
  // simply skipped, keeping whatever was last known-good, and a later
  // successful poll fills in an opening value that was missing.
  const idx = history.findIndex((h) => h.date === today);
  if (idx >= 0) {
    const existing = history[idx];
    const nextPlayers = { ...existing.players };
    const nextOpening = { ...(existing.opening_players || {}) };
    for (const p of PLAYERS) {
      if (!players[p.key].ok) continue; // keep last known-good, don't clobber
      nextPlayers[p.key] = players[p.key];
      if (!nextOpening[p.key]?.ok) nextOpening[p.key] = players[p.key];
    }
    existing.collected_at = new Date().toISOString();
    existing.players = nextPlayers;
    existing.opening_players = nextOpening;
  } else {
    // Starting a new day: whatever happened between the previous day's
    // last poll and this exact instant (the CEST midnight boundary) would
    // otherwise be invisible — neither day's delta would ever count it.
    // Back-fill the previous day's closing value with this same successful
    // reading, since nothing else could have changed in that gap.
    const prevEntry = history.length > 0 ? history[history.length - 1] : null;
    if (prevEntry) {
      for (const p of PLAYERS) {
        if (players[p.key].ok) prevEntry.players[p.key] = players[p.key];
      }
    }
    history.push({ date: today, collected_at: new Date().toISOString(), opening_players: players, players });
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
  console.log(`Snapshot for ${today} saved (${history.length} day(s) total).`);

  const lastRank = rankHistory.length > 0 ? rankHistory[rankHistory.length - 1] : null;
  const currentRanks = {};
  for (const p of PLAYERS) {
    // A failed fetch is not "unranked" — that would read as a real change
    // (and get recorded as one). Carry the last known rank forward instead.
    currentRanks[p.key] = players[p.key].ok ? players[p.key].competitive : (lastRank ? lastRank.players[p.key] : null);
  }
  const rankChanged = PLAYERS.some((p) => !deepEqual(currentRanks[p.key], lastRank ? lastRank.players[p.key] : undefined));
  // Also record an entry for the first poll of a new day even if nothing
  // changed — the chart should always show a day's opening rank, not just
  // the days something happened to move.
  const isNewDay = !lastRank || cestDate(new Date(lastRank.timestamp)) !== today;
  if (rankChanged || isNewDay) {
    rankHistory.push({ timestamp: new Date().toISOString(), players: currentRanks });
    await writeFile(RANK_HISTORY_PATH, JSON.stringify(rankHistory, null, 2) + "\n");
    console.log(`Rank event recorded (${rankHistory.length} event(s) total).`);
  } else {
    console.log("No rank change since last recorded event.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
