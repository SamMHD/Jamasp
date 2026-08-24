import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * A freshly deployed host has no `item_scores` table until the first CLI
 * scoring run creates it. This fixture models exactly that: an `items`
 * table with rows, and no `item_scores` table at all — not an empty one.
 * Own fixture root, like db-marketmap.test.ts, so this file's absent table
 * can't be confused with that file's populated one.
 */
let db: typeof import("../lib/db");

beforeAll(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jamasp-db-marketmap-no-table-"));
  mkdirSync(path.join(root, "state"), { recursive: true });
  const d = new Database(path.join(root, "state", "jamasp.db"));
  d.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, source TEXT NOT NULL,
      published_at TEXT NOT NULL, headline TEXT NOT NULL, lede TEXT,
      url TEXT NOT NULL, topic TEXT NOT NULL, cluster_id TEXT,
      fetched_at TEXT NOT NULL, read_at TEXT);
    INSERT INTO items VALUES
      ('w1','reuters','2026-08-19T20:00:00Z','Late story',NULL,
       'https://x.test/w1','gold',NULL,'2026-08-19T20:00:00Z',NULL);
  `);
  d.close();
  process.env.JAMASP_ROOT = root;
  db = await import("../lib/db");
});

const SINCE = "2026-08-19T00:00:00Z";

describe("getScoredItems against a database with no item_scores table", () => {
  it("returns an empty array rather than throwing", () => {
    expect(() => db.getScoredItems(SINCE)).not.toThrow();
    expect(db.getScoredItems(SINCE)).toEqual([]);
  });
});

describe("unscoredCountSince against a database with no item_scores table", () => {
  it("returns 0 rather than throwing", () => {
    expect(() => db.unscoredCountSince(SINCE)).not.toThrow();
    expect(db.unscoredCountSince(SINCE)).toBe(0);
  });
});

describe("latestSignalStates against a database with no signal_states table", () => {
  it("returns an empty array rather than throwing", () => {
    // A host that has not run `jamasp signals refresh` yet must still serve
    // the overview page — the same guard getScoredItems carries.
    expect(() => db.latestSignalStates()).not.toThrow();
    expect(db.latestSignalStates()).toEqual([]);
  });
});
