import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * The news-flow readers need cluster shapes the shared fixture deliberately
 * keeps minimal (multi-source clusters, multi-day volume), so this file
 * builds its own root. Safe alongside db.test.ts: vitest isolates files
 * into separate workers, so each import of lib/db binds its own
 * JAMASP_ROOT.
 */

let db: typeof import("../lib/db");

const item = (id: string, source: string, publishedAt: string, topic: string,
  clusterId: string | null, headline = `headline ${id}`) =>
  `('${id}','${source}','${publishedAt}','${headline}',NULL,'https://x.test/${id}','${topic}',` +
  (clusterId === null ? "NULL" : `'${clusterId}'`) + `,'${publishedAt}',NULL)`;

beforeAll(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jamasp-db-news-"));
  mkdirSync(path.join(root, "state"), { recursive: true });
  const d = new Database(path.join(root, "state", "jamasp.db"));
  d.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, source TEXT NOT NULL,
      published_at TEXT NOT NULL, headline TEXT NOT NULL, lede TEXT,
      url TEXT NOT NULL, topic TEXT NOT NULL, cluster_id TEXT,
      fetched_at TEXT NOT NULL, read_at TEXT);
    INSERT INTO items VALUES
      ${item("a1", "reuters", "2026-08-10T08:00:00Z", "regional", "a1", "Strait strike claim")},
      ${item("a2", "cnbc_finance", "2026-08-10T08:30:00Z", "regional", "a1")},
      ${item("a3", "ft_markets", "2026-08-10T09:00:00Z", "regional", "a1")},
      ${item("b1", "reuters", "2026-08-10T10:00:00Z", "gold", "b1", "Gold holds 4380")},
      ${item("b2", "reuters", "2026-08-10T11:00:00Z", "gold", "b1")},
      ${item("c1", "cnbc_finance", "2026-08-09T12:00:00Z", "fed", null, "Fed speaker")},
      ${item("d1", "ft_markets", "2026-08-01T12:00:00Z", "gold", "d1", "Old story")};
  `);
  d.close();
  process.env.JAMASP_ROOT = root;
  db = await import("../lib/db");
});

describe("newestItemTs", () => {
  it("returns the newest published_at", () => {
    expect(db.newestItemTs()).toBe("2026-08-10T11:00:00Z");
  });
});

describe("itemVolumeByDay", () => {
  it("aggregates per UTC day per topic from the cutoff", () => {
    expect(db.itemVolumeByDay("2026-08-09T00:00:00Z")).toEqual([
      { day: "2026-08-09", topic: "fed", n: 1 },
      { day: "2026-08-10", topic: "gold", n: 2 },
      { day: "2026-08-10", topic: "regional", n: 3 },
    ]);
  });
  it("excludes items before the cutoff", () => {
    const days = db.itemVolumeByDay("2026-08-09T00:00:00Z").map(r => r.day);
    expect(days).not.toContain("2026-08-01");
  });
});

describe("getClusterHeads", () => {
  it("returns representatives only, with distinct-source counts", () => {
    const heads = db.getClusterHeads(10);
    expect(heads.map(h => h.id)).toEqual(["b1", "a1", "c1", "d1"]);
    // a2/a3 folded into a1; b2 (same source) folded into b1.
    expect(heads.find(h => h.id === "a1")?.sources_n).toBe(3);
    // Two items, one source: one wire carrying the story, not two.
    expect(heads.find(h => h.id === "b1")?.sources_n).toBe(1);
  });
  it("counts an unclustered item as its own single source, never zero", () => {
    expect(db.getClusterHeads(10).find(h => h.id === "c1")?.sources_n).toBe(1);
  });
  it("respects the limit newest-first", () => {
    expect(db.getClusterHeads(1).map(h => h.id)).toEqual(["b1"]);
  });
});

describe("topStory", () => {
  it("returns the most-sourced cluster with its representative row", () => {
    const t = db.topStory("2026-08-09T00:00:00Z");
    expect(t?.item.headline).toBe("Strait strike claim");
    expect(t?.sources).toBe(3);
    expect(t?.items).toBe(3);
  });
  it("never promotes a single-source cluster to top story", () => {
    // b1 (2 items, 1 source) is the only cluster left when the regional
    // one falls outside the cutoff — and it must not qualify.
    expect(db.topStory("2026-08-10T09:30:00Z")).toBeNull();
  });
  it("returns null when nothing clusters in the window", () => {
    expect(db.topStory("2026-08-11T00:00:00Z")).toBeNull();
  });
});
