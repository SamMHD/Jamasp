import { describe, expect, it } from "vitest";
import { cls, fmtAge, fmtDubai, fmtUtc } from "../lib/format";

describe("format", () => {
  it("fmtUtc renders month day hh:mmZ", () => {
    expect(fmtUtc("2026-08-01T14:05:00Z")).toBe("Aug 1 14:05Z");
  });
  it("fmtDubai adds four hours", () => {
    expect(fmtDubai("2026-08-01T14:05:00Z")).toBe("18:05 DXB");
  });
  it("fmtAge handles past and future", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    expect(fmtAge("2026-08-01T09:00:00Z", now)).toBe("3h ago");
    expect(fmtAge("2026-08-01T14:00:00Z", now)).toBe("in 2h");
  });
  it("cls joins truthy parts", () => {
    expect(cls("a", false, "b", undefined)).toBe("a b");
  });
});
