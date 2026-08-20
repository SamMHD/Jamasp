import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";

let db: typeof import("../lib/db");

beforeAll(async () => {
  execFileSync("node", [path.resolve(__dirname, "../scripts/build-fixture.mjs")]);
  process.env.JAMASP_ROOT = path.resolve(__dirname, "fixtures/root");
  db = await import("../lib/db");
});

describe("db layer", () => {
  it("counts unread cluster representatives", () => {
    // i1, i2 unread; i3 read + clustered under i1; map1/map2 (the
    // fundamental-map fixture rows build-fixture.mjs adds with real-time-
    // relative dates — see its own comment) are each their own cluster
    // head and unread too.
    expect(db.getUnreadCount()).toBe(4);
  });
  it("filters items by source and read state", () => {
    expect(db.getItems({ source: "cnbc_finance" }).map(r => r.id)).toEqual(["i1", "i3"]);
    // Newest first: map1/map2 are dated relative to build time (minutes/days
    // ago), always newer than the fixture's fixed 2026-08-01 items.
    expect(db.getItems({ unreadOnly: true }).map(r => r.id)).toEqual(["map1", "map2", "i1", "i2"]);
  });
  it("searches headline and lede case-insensitively", () => {
    expect(db.getItems({ search: "dollar" }).map(r => r.id)).toEqual(["i1", "i3"]);
    expect(db.getItems({ search: "held NEAR" }).map(r => r.id)).toEqual(["i1"]); // lede match
    expect(db.getItems({ search: "%" })).toEqual([]); // LIKE wildcards are literal
    expect(db.getItems({ search: "_old" })).toEqual([]);
  });
  it("paginates with limit and offset", () => {
    // Full published_at-desc order is now [map1, map2, i1, i2, i3] — map1/
    // map2 are always newer than the fixture's fixed 2026-08-01 items (see
    // build-fixture.mjs).
    expect(db.getItems({ limit: 2 }).map(r => r.id)).toEqual(["map1", "map2"]);
    expect(db.getItems({ limit: 2, offset: 2 }).map(r => r.id)).toEqual(["i1", "i2"]);
    expect(db.getItems({ offset: 5 })).toEqual([]);
  });
  it("computes price snapshots with deltas", () => {
    const gc = db.getPriceSnapshots(new Date("2026-08-01T09:00:00Z")).find(s => s.symbol === "GC")!;
    expect(gc.value).toBe(3325.0);
    expect(gc.delta24h).toBeCloseTo(3325.0 - 3310.5);
    expect(gc.delta7d).toBeCloseTo(3325.0 - 3290.0);
  });
  it("runsTodayDubai counts non-deferred runs on the Dubai day", () => {
    expect(db.runsTodayDubai(new Date("2026-08-01T09:00:00Z"))).toBe(2);
  });
  it("reads wakeups, events, notify log", () => {
    expect(db.getWakeups("pending").map(w => w.id)).toEqual([1]);
    expect(db.getEvents(30, new Date("2026-08-01T00:00:00Z")).length).toBe(2);
    expect(db.getNotifyLog(10)[0].ok).toBe(0); // newest first
  });
  it("orders unfiltered wakeups by due_at descending (history view)", () => {
    // id 1 due 2026-08-02, id 2 due 2026-07-31 -> DESC gives [1, 2].
    expect(db.getWakeups().map(w => w.id)).toEqual([1, 2]);
  });
  it("returns an ascending price series from a cutoff", () => {
    expect(db.getPriceSeries("GC", "2026-07-30T00:00:00Z").map(p => p.value))
      .toEqual([3310.5, 3325.0]);
  });
  it("lastRunPerType finds the newest run for a type even outside a small window", () => {
    // Fixture has one 'retro' run dated 2026-07-20, well older than the
    // three 2026-08-01 runs of other types. A limit of 3 (via getAgentRuns)
    // only reaches back to those three same-day runs, so a naive
    // `.find()` over that window never sees the retro row at all.
    const windowed = db.getAgentRuns(3);
    expect(windowed.find(r => r.run_type === "retro")).toBeUndefined();

    const perType = db.lastRunPerType();
    const retro = perType.find(r => r.run_type === "retro");
    expect(retro?.started_at).toBe("2026-07-20T05:00:00Z");
    // Still one row per type for the types that *are* in the recent window.
    expect(perType.find(r => r.run_type === "brief")?.started_at)
      .toBe("2026-08-01T05:00:00Z");
    expect(perType.find(r => r.run_type === "scan")?.started_at)
      .toBe("2026-08-01T07:00:00Z");
    expect(perType.map(r => r.run_type).sort())
      .toEqual(["brief", "deepdive", "retro", "scan"]);
  });
});

describe("latestPrices", () => {
  it("returns the newest row per requested symbol", () => {
    const out = db.latestPrices(["GC", "GC_SMA200"]);
    expect(out.GC).toEqual({ ts: "2026-08-01T08:00:00Z", value: 3325.0 });
    expect(out.GC_SMA200).toEqual({ ts: "2026-08-01T06:00:00Z", value: 3400.0 });
  });

  it("omits symbols with no rows rather than returning nulls", () => {
    const out = db.latestPrices(["GC", "NOPE"]);
    expect(out.GC).toBeDefined();
    expect(out.NOPE).toBeUndefined();
  });

  it("returns an empty object for an empty symbol list without querying", () => {
    expect(db.latestPrices([])).toEqual({});
  });

  it("does not touch the database for an empty symbol list", () => {
    // The size check above is guaranteed to hold even without the early
    // return: SQLite treats `IN ()` as always-false, not a syntax error, so
    // a missing guard would still yield `{}`. This spy is what actually
    // proves the short-circuit fires.
    const spy = vi.spyOn(Database.prototype, "prepare");
    try {
      db.latestPrices([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// GC fixture rows: 07-25 3290, 07-31 3310.5, 08-01T08:00Z 3325 (the latest).
const GC_LATEST = "2026-08-01T08:00:00Z";

describe("priceDeltaReference", () => {
  it("returns the newest value at or before the cutoff, not the next one after it", () => {
    // A cutoff mid-gap must return the earlier row, never jump forward.
    expect(db.priceDeltaReference("GC", "2026-07-28T00:00:00Z", GC_LATEST)).toBe(3290.0);
  });

  it("includes a row exactly on the cutoff", () => {
    expect(db.priceDeltaReference("GC", "2026-07-31T08:00:00Z", GC_LATEST)).toBe(3310.5);
  });

  it("returns null when nothing precedes the cutoff", () => {
    expect(db.priceDeltaReference("GC", "2026-07-01T00:00:00Z", GC_LATEST)).toBeNull();
  });

  it("returns null for an unknown symbol", () => {
    expect(db.priceDeltaReference("NOPE", "2026-08-01T08:00:00Z", GC_LATEST)).toBeNull();
  });

  // The weekend case, and the reason this is not a bare at-or-before lookup.
  // COMEX gold closes Friday ~21:00Z; rows carry the market bar timestamp, so
  // from Saturday ~21:00Z the 24h cutoff falls *after* the last bar and the
  // newest-at-or-before row is the latest row itself. Subtracting it from
  // itself would print "= 0 (0.00%)" — gold asserted unchanged — for ~26h
  // every weekend, while jamasp/pricesummary.py#_delta prints "n/a".
  it("returns null when the series has not printed since the cutoff", () => {
    // Cutoff 2026-08-02, latest bar 08-01T08:00Z: the row found *is* the
    // latest row.
    expect(db.priceDeltaReference("GC", "2026-08-02T00:00:00Z", GC_LATEST)).toBeNull();
  });

  it("returns null when the reference row is exactly the latest row", () => {
    expect(db.priceDeltaReference("GC", GC_LATEST, GC_LATEST)).toBeNull();
  });

  it("still returns a reference when one older row exists before the latest", () => {
    // Same cutoff shape as the weekend case but with the latest row a bar
    // later — isolates the >= guard from the at-or-before lookup.
    expect(db.priceDeltaReference("GC", "2026-08-01T00:00:00Z", GC_LATEST)).toBe(3310.5);
  });
});
