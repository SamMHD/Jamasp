import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Own fixture root, like db-news.test.ts: the map reader needs a URL-collision
 * shape and an implausible date that no other fixture carries. vitest isolates
 * files into separate workers, so each import of lib/db binds its own root.
 */
let db: typeof import("../lib/db");

const item = (id: string, url: string, publishedAt: string, headline: string) =>
  `('${id}','reuters','${publishedAt}','${headline}',NULL,'${url}','gold',NULL,` +
  `'${publishedAt}',NULL)`;

const score = (id: string, tier: number, dir: number, conv: number, theme: string) =>
  `('${id}',${tier},${dir},${conv},'${theme}','2026-08-19T22:00:00Z')`;

beforeAll(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jamasp-db-marketmap-"));
  mkdirSync(path.join(root, "state"), { recursive: true });
  const d = new Database(path.join(root, "state", "jamasp.db"));
  d.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, source TEXT NOT NULL,
      published_at TEXT NOT NULL, headline TEXT NOT NULL, lede TEXT,
      url TEXT NOT NULL, topic TEXT NOT NULL, cluster_id TEXT,
      fetched_at TEXT NOT NULL, read_at TEXT);
    CREATE TABLE item_scores (item_id TEXT PRIMARY KEY, tier INTEGER NOT NULL,
      direction INTEGER NOT NULL, conviction REAL NOT NULL, theme TEXT NOT NULL,
      scored_at TEXT NOT NULL);
    INSERT INTO items VALUES
      ${item("w1", "https://x.test/w1", "2026-08-19T20:00:00Z", "Late story")},
      ${item("w2", "https://x.test/w2", "2026-08-19T18:00:00Z", "Earlier story")},
      ${item("old", "https://x.test/old", "2026-08-01T12:00:00Z", "Outside window")},
      ${item("dupA", "https://x.test/dup", "2026-08-19T19:00:00Z", "Gold at 4400")},
      ${item("dupB", "https://x.test/dup", "2026-08-19T19:05:00Z", "Gold at 4450 now")},
      ${item("dupC", "https://x.test/dup", "2026-08-19T19:10:00Z", "Gold RSI 77")},
      ${item("tieA", "https://x.test/tie", "2026-08-10T09:00:00Z", "Tie story A")},
      ${item("tieB", "https://x.test/tie", "2026-08-10T10:00:00Z", "Tie story B")},
      ${item("bogus", "https://x.test/bogus", "1786-08-01T00:00:00Z", "Epoch artefact")},
      ${item("unscoredIn", "https://x.test/unscored-in", "2026-08-19T21:30:00Z", "Filed but not yet scored")},
      ${item("unscoredOut", "https://x.test/unscored-out", "2026-08-18T23:00:00Z", "Unscored, before the window")};
    INSERT INTO item_scores VALUES
      ${score("w1", 4, 2, 0.8, "rates_dollar")},
      ${score("w2", 3, -1, 0.6, "rates_dollar")},
      ${score("old", 5, 2, 0.9, "geopolitics")},
      ${score("dupA", 2, 1, 0.3, "other")},
      ${score("dupB", 4, 1, 0.5, "other")},
      ${score("dupC", 3, 0, 0.2, "other")},
      ${score("tieA", 5, 1, 0.5, "supply_demand")},
      ${score("tieB", 5, -1, 0.5, "supply_demand")},
      ${score("bogus", 5, 2, 0.9, "geopolitics")};
  `);
  d.close();
  process.env.JAMASP_ROOT = root;
  db = await import("../lib/db");
});

const SINCE = "2026-08-19T00:00:00Z";
// Isolated window for the tie fixture: starts after "old" (2026-08-01) and
// before the w1/w2/dup group (2026-08-19), so it never perturbs the exact
// ordering assertion above, which is pinned to SINCE.
const TIE_SINCE = "2026-08-10T00:00:00Z";

describe("getScoredItems", () => {
  it("returns items inside the window, newest first", () => {
    const rows = db.getScoredItems(SINCE);
    // dupB, not dupC: the collapse keeps the highest tier (dupB is tier 4),
    // and dupB's 19:05 sits between w2's 18:00 and w1's 20:00.
    expect(rows.map(r => r.itemId)).toEqual(["w1", "dupB", "w2"]);
  });

  it("excludes items published before the window", () => {
    expect(db.getScoredItems(SINCE).some(r => r.itemId === "old")).toBe(false);
  });

  it("collapses three ids sharing one URL into a single highest-tier row", () => {
    // docs/todo/002: a publisher rewriting a live headline mints a new item id
    // for a URL already posted. Three tiles for one story is three times the
    // area in its theme, which then biases the fit. dupB carries tier 4.
    const rows = db.getScoredItems(SINCE);
    const dup = rows.filter(r => r.url === "https://x.test/dup");
    expect(dup).toHaveLength(1);
    expect(dup[0].tier).toBe(4);
  });

  it("collapses two ids sharing one URL at the SAME max tier into a single row", () => {
    // dupA/B/C (above) carry distinct tiers, so the MAX(tier) subquery alone
    // already narrows that URL to one row -- GROUP BY i.url does no work in
    // that case and could be deleted without failing a single test. tieA and
    // tieB are a genuine tie (both tier 5), so MAX(tier) admits both rows and
    // only GROUP BY collapses them to one. See the discrimination check in
    // the fix report: deleting GROUP BY i.url makes this assertion fail.
    const rows = db.getScoredItems(TIE_SINCE);
    const tie = rows.filter(r => r.url === "https://x.test/tie");
    expect(tie).toHaveLength(1);
    expect(tie[0].tier).toBe(5);
  });

  it("rejects an implausible published_at even when the window would admit it", () => {
    // The year-2000 floor is defensive: with any realistic window start, a
    // pre-2000 date is already excluded by the window filter itself, since
    // ISO strings compare lexically. Passing an ancient window start is what
    // makes this test able to fail if the floor is ever removed.
    const rows = db.getScoredItems("1000-01-01T00:00:00Z");
    expect(rows.some(r => r.itemId === "bogus")).toBe(false);
    expect(rows.some(r => r.itemId === "old")).toBe(true);
  });

  it("carries the fields the map needs", () => {
    const [first] = db.getScoredItems(SINCE);
    expect(first).toMatchObject({
      itemId: "w1", tier: 4, direction: 2, conviction: 0.8,
      theme: "rates_dollar", source: "reuters", headline: "Late story",
    });
  });

  it("returns an empty array when the window holds nothing", () => {
    // The component renders an empty state; it must not receive undefined.
    expect(db.getScoredItems("2030-01-01T00:00:00Z")).toEqual([]);
  });
});

describe("unscoredCountSince", () => {
  it("counts unscored items in the window but not scored ones", () => {
    // Inside SINCE: w1, w2, dupA/B/C are all scored (5 items, 3 distinct
    // urls, 0 unscored) and unscoredIn carries no item_scores row at all.
    // A query that ignored the NOT EXISTS join, or joined it backwards,
    // would return 6 (every item) or 0 (every item, the other way) instead
    // of exactly 1 — this discriminates both directions.
    expect(db.unscoredCountSince(SINCE)).toBe(1);
  });

  it("excludes an unscored item published before the window", () => {
    // unscoredOut sits at 2026-08-18T23:00Z, one hour before SINCE. A query
    // with a wrong window bound (off-by-one, or no bound at all) would
    // count it too and this would fail with 2 instead of 1.
    expect(db.unscoredCountSince(SINCE)).toBe(1);
    expect(db.unscoredCountSince("2026-08-18T00:00:00Z")).toBe(2);
  });

  it("returns 0 when the window holds nothing", () => {
    expect(db.unscoredCountSince("2030-01-01T00:00:00Z")).toBe(0);
  });
});
