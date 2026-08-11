import { describe, expect, it } from "vitest";
import { deriveNewsPulse } from "../lib/newsflow";

describe("deriveNewsPulse", () => {
  it("zero-fills a window anchored to the newest item's day", () => {
    const p = deriveNewsPulse(
      [{ day: "2026-08-10", topic: "gold", n: 3 },
       { day: "2026-08-08", topic: "regional", n: 7 }],
      "2026-08-10T03:11:26Z", 5);
    expect(p.anchorDay).toBe("2026-08-10");
    expect(p.days.map(d => d.day)).toEqual(
      ["2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10"]);
    expect(p.days.map(d => d.gold + d.other)).toEqual([0, 0, 7, 0, 3]);
    expect(p.total).toBe(10);
    expect(p.maxTotal).toBe(7);
  });

  it("splits gold from other and keeps the full topic breakdown", () => {
    const p = deriveNewsPulse(
      [{ day: "2026-08-10", topic: "gold", n: 3 },
       { day: "2026-08-10", topic: "regional", n: 5 },
       { day: "2026-08-10", topic: "fed", n: 2 }],
      "2026-08-10T12:00:00Z", 1);
    expect(p.days[0]).toMatchObject({ gold: 3, other: 7 });
    expect(p.days[0].byTopic).toEqual({ gold: 3, regional: 5, fed: 2 });
  });

  it("ignores rows outside the day window (the SQL cutoff is wider)", () => {
    const p = deriveNewsPulse(
      [{ day: "2026-08-05", topic: "gold", n: 9 },
       { day: "2026-08-11", topic: "gold", n: 9 }],
      "2026-08-10T12:00:00Z", 5);
    // 08-05 precedes the 5-day window (08-06..08-10); 08-11 postdates the anchor.
    expect(p.total).toBe(0);
  });

  it("states emptiness when no items exist at all", () => {
    expect(deriveNewsPulse([], null)).toEqual(
      { days: [], anchorDay: null, total: 0, maxTotal: 0 });
  });

  it("returns the empty shape for an unparseable anchor rather than guessing", () => {
    expect(deriveNewsPulse([{ day: "2026-08-10", topic: "gold", n: 1 }], "garbage").days)
      .toEqual([]);
  });
});
