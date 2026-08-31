import { describe, expect, it } from "vitest";
import { resolveRange, windowSinceIso } from "../app/page";

describe("resolveRange", () => {
  it("selects week only for the exact string 'week'", () => {
    expect(resolveRange("week")).toBe("week");
  });
  it("defaults to 24h when the param is absent", () => {
    expect(resolveRange(undefined)).toBe("24h");
  });
  it("defaults to 24h on a garbage value rather than throwing", () => {
    expect(resolveRange("banana")).toBe("24h");
  });
  it("degrades a bookmarked ?w=today to 24h", () => {
    // The short window was Dubai-midnight-anchored and spelled "today"
    // until it became rolling. An old bookmark must land somewhere sane
    // rather than throwing or rendering an empty map.
    expect(resolveRange("today")).toBe("24h");
  });
  it("takes the first value of a repeated param", () => {
    expect(resolveRange(["week", "24h"])).toBe("week");
    expect(resolveRange(["24h", "week"])).toBe("24h");
  });
});

describe("windowSinceIso", () => {
  it("week is exactly 7 days before now", () => {
    const now = new Date("2026-08-19T23:05:51Z");
    expect(windowSinceIso("week", now)).toBe("2026-08-12T23:05:51Z");
  });

  it("24h is exactly 24 hours before now, to the second", () => {
    const now = new Date("2026-08-19T23:05:51Z");
    expect(windowSinceIso("24h", now)).toBe("2026-08-18T23:05:51Z");
  });

  it("24h does not snap to any day boundary", () => {
    // The distinguishing property. Under the old Dubai-midnight window both
    // of these instants resolved to the SAME start (2026-08-19T20:00:00Z),
    // because they sit either side of 00:00 Dubai on the same Dubai day.
    // A rolling window must move with `now`, so they must differ by exactly
    // the hour that separates them.
    const before = new Date("2026-08-19T20:30:00Z"); // 00:30 Dubai
    const after = new Date("2026-08-19T21:30:00Z"); // 01:30 Dubai
    expect(windowSinceIso("24h", before)).toBe("2026-08-18T20:30:00Z");
    expect(windowSinceIso("24h", after)).toBe("2026-08-18T21:30:00Z");
    expect(windowSinceIso("24h", before)).not.toBe(windowSinceIso("24h", after));
  });

  it("spans the Dubai midnight that used to empty the map", () => {
    // The bug this change fixes: at 00:11 Dubai (20:11Z) the old window
    // started 11 minutes earlier and held almost nothing. The rolling
    // window reaches back a full day, across the boundary.
    const now = new Date("2026-08-24T20:11:20Z"); // 00:11 Dubai, Aug 25
    expect(windowSinceIso("24h", now)).toBe("2026-08-23T20:11:20Z");
  });
});
