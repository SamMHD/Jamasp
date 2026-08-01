import { describe, expect, it } from "vitest";
import { RUN_TYPES, validateWakeup } from "../lib/validate";

describe("validateWakeup", () => {
  it("accepts ISO with Z and normalizes", () => {
    const r = validateWakeup("2030-01-01T05:00:00Z", "scan", "check");
    expect(r).toEqual({ ok: true, dueAtUtc: "2030-01-01T05:00:00Z" });
  });

  it("accepts offset time, converts to Z", () => {
    const r = validateWakeup("2030-01-01T09:00:00+04:00", "deepdive", "t");
    // +04:00 offset must actually be subtracted, not just re-stamped with Z
    expect(r).toEqual({ ok: true, dueAtUtc: "2030-01-01T05:00:00Z" });
  });

  it("accepts a negative offset and converts correctly", () => {
    const r = validateWakeup("2030-01-01T01:00:00-05:00", "brief", "t");
    expect(r).toEqual({ ok: true, dueAtUtc: "2030-01-01T06:00:00Z" });
  });

  it("rejects a naive datetime (no timezone marker)", () => {
    const r = validateWakeup("2030-01-01T05:00:00", "scan", "t");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timezone/i);
  });

  it("rejects an unknown run type, with each valid run type accepted", () => {
    const bad = validateWakeup("2030-01-01T05:00:00Z", "party", "t");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/run type/i);

    for (const rt of RUN_TYPES) {
      const good = validateWakeup("2030-01-01T05:00:00Z", rt, "t");
      expect(good.ok).toBe(true);
    }
  });

  it("rejects an empty/whitespace task but accepts a real one", () => {
    const blank = validateWakeup("2030-01-01T05:00:00Z", "scan", "  ");
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error).toMatch(/task/i);

    const real = validateWakeup("2030-01-01T05:00:00Z", "scan", "check the fed statement");
    expect(real.ok).toBe(true);
  });

  it("rejects a value with no timezone marker at all", () => {
    const r = validateWakeup("garbage", "scan", "t");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timezone/i);
  });

  it("rejects a timezone-shaped but unparseable datetime", () => {
    // ends in Z so it passes the timezone-marker check, but is not a real date -
    // this specifically exercises the Date.parse/isNaN branch, not the tz-marker branch
    const r = validateWakeup("garbageZ", "scan", "t");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/ISO-8601/i);
      expect(r.error).toContain("garbageZ");
    }
  });
});
