import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

let db: typeof import("../lib/db");

beforeAll(async () => {
  execFileSync("node", [path.resolve(__dirname, "../scripts/build-fixture.mjs")]);
  process.env.JAMASP_ROOT = path.resolve(__dirname, "fixtures/root");
  db = await import("../lib/db");
});

describe("db layer", () => {
  it("counts unread cluster representatives", () => {
    expect(db.getUnreadCount()).toBe(2); // i1, i2 unread; i3 read + clustered under i1
  });
  it("filters items by source and read state", () => {
    expect(db.getItems({ source: "cnbc_finance" }).map(r => r.id)).toEqual(["i1", "i3"]);
    expect(db.getItems({ unreadOnly: true }).map(r => r.id)).toEqual(["i1", "i2"]);
  });
  it("searches headline and lede case-insensitively", () => {
    expect(db.getItems({ search: "dollar" }).map(r => r.id)).toEqual(["i1", "i3"]);
    expect(db.getItems({ search: "held NEAR" }).map(r => r.id)).toEqual(["i1"]); // lede match
    expect(db.getItems({ search: "%" })).toEqual([]); // LIKE wildcards are literal
    expect(db.getItems({ search: "_old" })).toEqual([]);
  });
  it("paginates with limit and offset", () => {
    expect(db.getItems({ limit: 2 }).map(r => r.id)).toEqual(["i1", "i2"]);
    expect(db.getItems({ limit: 2, offset: 2 }).map(r => r.id)).toEqual(["i3"]);
    expect(db.getItems({ offset: 3 })).toEqual([]);
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
