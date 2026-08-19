// Fetches current OverFast API stats for both players and upserts today's
// entry (UTC date) into data/history.json. Run daily via GitHub Actions.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = "https://overfast-api.tekrop.fr";
const HISTORY_PATH = path.join(__dirname, "..", "data", "history.json");

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

async function main() {
  await mkdir(path.dirname(HISTORY_PATH), { recursive: true });

  let history = [];
  try {
    const raw = (await readFile(HISTORY_PATH, "utf8")).replace(/^﻿/, ""); // strip BOM if present
    history = JSON.parse(raw);
  } catch (err) {
    console.error(`Could not read/parse existing history.json, starting fresh: ${err.message}`);
  }

  const today = new Date().toISOString().slice(0, 10); // UTC calendar date
  const players = {};
  for (const p of PLAYERS) {
    players[p.key] = await collectPlayer(p);
  }

  const entry = { date: today, collected_at: new Date().toISOString(), players };
  const idx = history.findIndex((h) => h.date === today);
  if (idx >= 0) history[idx] = entry; else history.push(entry);
  history.sort((a, b) => a.date.localeCompare(b.date));

  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
  console.log(`Snapshot for ${today} saved (${history.length} day(s) total).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
