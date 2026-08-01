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
});
