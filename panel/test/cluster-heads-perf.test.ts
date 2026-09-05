import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * getClusterHeads must cost O(limit), not O(table).
 *
 * The original single-statement form carried the distinct-source count as a
 * correlated subquery in its SELECT list. SQLite evaluates that per candidate
 * row, and `LIMIT 8` cannot narrow the candidates until `ORDER BY
 * published_at DESC` has ranked all of them — so every head in the table got
 * a full scan of `items` (no index on cluster_id) plus a temp b-tree for the
 * DISTINCT. On the live database — 14.1k items, 12.3k heads — the call took
 * **9.27 seconds** and was single-handedly responsible for the overview
 * route answering in 9.1s while every other route answered in 15–35ms.
 *
 * A wall-clock assertion is a blunt instrument, so both margins were measured
 * rather than guessed. At 8,000 heads on this hardware the old shape takes
 * **4,866ms** and the rewrite takes **4.1ms** (a 1,187x gap, and the gap
 * widens with table size because the old shape is quadratic). A 1-second
 * ceiling therefore sits ~5x above the shape it must catch and ~240x below
 * the shape it must pass, which is wide enough that a loaded CI box cannot
 * flake it in either direction.
 */

let db: typeof import("../lib/db");
const HEADS = 8_000;
const CEILING_MS = 1_000;

beforeAll(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jamasp-heads-perf-"));
  mkdirSync(path.join(root, "state"), { recursive: true });
  const d = new Database(path.join(root, "state", "jamasp.db"));
  d.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, source TEXT NOT NULL,
    published_at TEXT NOT NULL, headline TEXT NOT NULL, lede TEXT,
    url TEXT NOT NULL, topic TEXT NOT NULL, cluster_id TEXT,
    fetched_at TEXT NOT NULL, read_at TEXT);`);
  const ins = d.prepare(
    "INSERT INTO items VALUES (?,?,?,?,NULL,?,'gold',?,?,NULL)");
  // Each head is its own cluster, plus one same-cluster follower — the shape
  // the real table has, and the one that makes the correlated count expensive.
  d.transaction(() => {
    for (let i = 0; i < HEADS; i++) {
      const id = `h${i}`;
      const ts = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      ins.run(id, `src${i % 12}`, ts, `headline ${i}`, `https://x.test/${i}`, id, ts);
      ins.run(`f${i}`, `src${(i + 5) % 12}`, ts, `follow ${i}`, `https://x.test/f${i}`, id, ts);
    }
  })();
  d.close();
  process.env.JAMASP_ROOT = root;
  db = await import("../lib/db");
});

describe("getClusterHeads at scale", () => {
  it(`returns 8 heads out of ${HEADS} in well under ${CEILING_MS}ms`, () => {
    const started = process.hrtime.bigint();
    const heads = db.getClusterHeads(8);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    expect(heads).toHaveLength(8);
    // Newest first, and each head carries the two distinct sources its
    // cluster holds — correctness has to survive the rewrite, not just speed.
    expect(heads[0].id).toBe(`h${HEADS - 1}`);
    expect(heads.every(h => h.sources_n === 2)).toBe(true);
    expect(ms, `getClusterHeads took ${ms.toFixed(0)}ms over ${HEADS} heads — ` +
      `that is the per-candidate correlated-subquery shape returning. Rank ` +
      `and LIMIT first, then count sources for the survivors.`)
      .toBeLessThan(CEILING_MS);
  });
});
