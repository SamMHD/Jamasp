import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../test/fixtures/root");
mkdirSync(path.join(root, "state"), { recursive: true });
const dbPath = path.join(root, "state", "jamasp.db");
rmSync(dbPath, { force: true });
const db = new Database(dbPath);
db.exec(readFileSync(path.resolve(import.meta.dirname, "../test/fixtures/fixture.sql"), "utf8"));

// The fundamental map's window is anchored to the real clock (Dubai
// midnight for "today", trailing 7 days for "week") rather than to the
// newest item, unlike the rest of this fixture — see fixture.sql's
// comments on how everything else stays fixed at 2026-08-01 and is read
// through windows anchored to the newest item instead. A hardcoded date
// can never satisfy "published today" as real time moves on, so these
// few rows are dated relative to build time, not baked into fixture.sql.
//
// todayAt must be computed from the actual Dubai-midnight boundary, not
// offset backward from `now` — the "today" window is wall-clock Dubai
// midnight (UTC 20:00:00 daily, see windowSinceIso in app/page.tsx), and a
// fixed offset from `now` (e.g. "10 minutes ago") lands *before* that
// boundary whenever the fixture happens to build within the first few
// minutes after UTC 20:00:00, silently dropping map1 out of the
// default-window e2e assertion. Mirrors windowSinceIso's own arithmetic:
// shift into Dubai local time, truncate to the day, shift back.
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const now = Date.now();
const DUBAI_OFFSET_MS = 4 * 3600_000; // UTC+4, no DST — same as app/page.tsx
const dubaiNow = now + DUBAI_OFFSET_MS;
const dubaiMidnightUtcMs = Date.UTC(
  new Date(dubaiNow).getUTCFullYear(),
  new Date(dubaiNow).getUTCMonth(),
  new Date(dubaiNow).getUTCDate(),
) - DUBAI_OFFSET_MS;
const todayAt = iso(dubaiMidnightUtcMs + 5 * 60_000); // 5 min after Dubai midnight — always "today"
const weekAt = iso(now - 3 * 86_400_000);   // 3 days ago — "week" but not "today"

const insertItem = db.prepare(`
  INSERT INTO items (id, source, published_at, headline, lede, url, topic, cluster_id, fetched_at, read_at)
  VALUES (?, ?, ?, ?, NULL, ?, 'gold', ?, ?, NULL)
`);
const insertScore = db.prepare(`
  INSERT INTO item_scores (item_id, tier, direction, conviction, theme, scored_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// map1: today, bullish, rates_dollar — exercises the plain (unhatched) tile path.
insertItem.run("map1", "reuters", todayAt,
  "Fed officials signal patience on rate cuts", "https://example.com/map1", "map1", todayAt);
insertScore.run("map1", 5, 2, 0.7, "rates_dollar", todayAt);

// map2: within the week but not today, bearish, geopolitics — exercises the
// hatch path (see market-map.tsx's compliance test for why both bearish
// steps, not just the pole, must hatch).
insertItem.run("map2", "ft", weekAt,
  "Miners warn of softer than expected output", "https://example.com/map2", "map2", weekAt);
insertScore.run("map2", 4, -2, 0.8, "geopolitics", weekAt);

db.close();
console.log(`fixture db written: ${dbPath}`);
