import { describe, expect, it } from "vitest";
import { resolveRange, windowSinceIso } from "../app/page";

describe("resolveRange", () => {
  it("selects week only for the exact string 'week'", () => {
    expect(resolveRange("week")).toBe("week");
  });
  it("defaults to today when the param is absent", () => {
    expect(resolveRange(undefined)).toBe("today");
  });
  it("defaults to today on a garbage value rather than throwing", () => {
    expect(resolveRange("banana")).toBe("today");
  });
  it("takes the first value of a repeated param", () => {
    expect(resolveRange(["week", "today"])).toBe("week");
    expect(resolveRange(["today", "week"])).toBe("today");
  });
});

describe("windowSinceIso", () => {
  it("week is exactly 7 days before now", () => {
    const now = new Date("2026-08-19T23:05:51Z");
    expect(windowSinceIso("week", now)).toBe("2026-08-12T23:05:51Z");
  });

  it("today is Dubai midnight (UTC+4, no DST) converted back to UTC", () => {
    // 2026-08-19T23:05:51Z is 2026-08-20T03:05:51 in Dubai, so Dubai
    // midnight for "today" is 2026-08-20T00:00 Dubai == 2026-08-19T20:00Z.
    const now = new Date("2026-08-19T23:05:51Z");
    expect(windowSinceIso("today", now)).toBe("2026-08-19T20:00:00Z");
  });

  it("today rolls over at the Dubai day boundary, not the UTC one", () => {
    // 2026-08-19T21:00:00Z is 2026-08-20T01:00 Dubai — already past Dubai
    // midnight even though UTC is still on the 19th.
    const now = new Date("2026-08-19T21:00:00Z");
    expect(windowSinceIso("today", now)).toBe("2026-08-19T20:00:00Z");
  });

  it("just before the Dubai rollover still resolves to the prior Dubai day", () => {
    // 2026-08-19T19:59:59Z is 2026-08-19T23:59:59 Dubai — one second before
    // the Dubai day turns over, so "today" is still Aug 19 Dubai-local,
    // whose midnight (Aug 18 20:00Z) is a full UTC day earlier than the
    // boundary case above.
    const now = new Date("2026-08-19T19:59:59Z");
    expect(windowSinceIso("today", now)).toBe("2026-08-18T20:00:00Z");
  });
});
