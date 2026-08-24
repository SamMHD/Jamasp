import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../test/fixtures/root");
mkdirSync(path.join(root, "state"), { recursive: true });
const dbPath = path.join(root, "state", "jamasp.db");
rmSync(dbPath, { force: true });
const db = new Database(dbPath);
db.exec(readFileSync(path.resolve(import.meta.dirname, "../test/fixtures/fixture.sql"), "utf8"));

// The fundamental map's windows are anchored to the real clock (trailing
// 24h, trailing 7 days) rather than to the newest item, unlike the rest of
// this fixture — see fixture.sql's comments on how everything else stays
// fixed at 2026-08-01 and is read through windows anchored to the newest
// item instead. A hardcoded date can never stay inside a trailing window as
// real time moves on, so these few rows are dated relative to build time,
// not baked into fixture.sql.
//
// Both offsets are now plain subtractions from `now`. They did not used to
// be: the short window was anchored to Dubai midnight, so `recentAt` had to
// be computed from that boundary — a fixed offset backward from `now` fell
// *before* it whenever the fixture happened to build in the first minutes
// after 20:00 UTC, silently dropping map1 out of the default-window
// assertion. A rolling window has no boundary to fall the wrong side of,
// which is the same cliff that emptied the live map at 00:00 Dubai.
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const now = Date.now();
const recentAt = iso(now - 10 * 60_000);  // 10 min ago — inside the 24h window
const weekAt = iso(now - 3 * 86_400_000); // 3 days ago — "week" but not 24h

const insertItem = db.prepare(`
  INSERT INTO items (id, source, published_at, headline, lede, url, topic, cluster_id, fetched_at, read_at)
  VALUES (?, ?, ?, ?, NULL, ?, 'gold', ?, ?, NULL)
`);
const insertScore = db.prepare(`
  INSERT INTO item_scores (item_id, tier, direction, conviction, theme, scored_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// map1: today, bullish, rates_dollar — exercises the plain (unhatched) tile path.
insertItem.run("map1", "reuters", recentAt,
  "Fed officials signal patience on rate cuts", "https://example.com/map1", "map1", recentAt);
insertScore.run("map1", 5, 2, 0.7, "rates_dollar", recentAt);

// map2: within the week but not today, bearish, geopolitics — exercises the
// hatch path (see market-map.tsx's compliance test for why both bearish
// steps, not just the pole, must hatch).
insertItem.run("map2", "ft", weekAt,
  "Miners warn of softer than expected output", "https://example.com/map2", "map2", weekAt);
insertScore.run("map2", 4, -2, 0.8, "geopolitics", weekAt);

// Technical map fixture. signal_states is created here rather than in
// fixture.sql because the panel's own missing-table guard is exercised by
// test/db-marketmap-no-table.test.ts; this file's job is the populated path.
db.exec(`CREATE TABLE IF NOT EXISTS signal_states (
  key TEXT NOT NULL, ts TEXT NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (key, ts))`);
const insertState = db.prepare(
  "INSERT INTO signal_states (key, ts, value) VALUES (?, ?, ?)");
// One bullish, one bearish (exercising the hatch path) and one unfitted
// (exercising the dashed path), across two families so the map has two boxes.
insertState.run("rsi14@1d", recentAt, -0.9);
insertState.run("sma50@1d", recentAt, 0.8);
insertState.run("macd@1d", recentAt, 0.4);

writeFileSync(path.join(root, "state", "weights.json"), JSON.stringify({
  fitted_at: recentAt,
  fits: {
    technical: {
      n: 16880, horizon_hours: 24, flags: [],
      coefficients: {
        "rsi14@1d": { beta: 0.03, se: 0.008, multiplier: 2.0,
                      observations: 900, fitted: true },
        "sma50@1d": { beta: 0.02, se: 0.009, multiplier: 1.2,
                      observations: 900, fitted: true },
        // macd@1d is deliberately absent: it must render dashed.
      },
    },
  },
}, null, 1));

db.close();
console.log(`fixture db written: ${dbPath}`);
