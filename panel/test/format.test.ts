import { describe, expect, it } from "vitest";
import { cls, fmtAge, fmtDubai, fmtUtc } from "../lib/format";
import { getMessages } from "../lib/i18n";
import fa from "../messages/fa.json";

const en = getMessages("en");

describe("format", () => {
  it("fmtUtc renders month day hh:mmZ", () => {
    expect(fmtUtc("2026-08-01T14:05:00Z")).toBe("Aug 1 14:05Z");
  });
  it("fmtDubai adds four hours", () => {
    expect(fmtDubai("2026-08-01T14:05:00Z")).toBe("18:05 DXB");
  });
  it("fmtAge handles past and future", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    expect(fmtAge("2026-08-01T09:00:00Z", en, now)).toBe("3h ago");
    expect(fmtAge("2026-08-01T14:00:00Z", en, now)).toBe("in 2h");
  });

  /**
   * fmtAge reaches the news flow, every quote tile, the status strip,
   * predictions and the stance header — the most-repeated string in the
   * panel, and it was English in both locales.
   *
   * The magnitude and unit stay Latin ("3h", "2d"): that is compact chrome
   * notation in the same register as "24h" and "w/w", which this codebase
   * already keeps Latin in both locales on purpose. Only the "ago"/"in"
   * wrapper — actual English words — goes through the dictionary.
   */
  it("fmtAge wraps the Latin magnitude in the locale's own words", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const faMsg = getMessages("fa");
    expect(fmtAge("2026-08-01T09:00:00Z", faMsg, now))
      .toBe(fa["time.agoTemplate"].replace("{age}", "3h"));
    expect(fmtAge("2026-08-01T14:00:00Z", faMsg, now))
      .toBe(fa["time.inTemplate"].replace("{age}", "2h"));
  });

  it("fmtAge keeps digits Latin and carries no English words in Persian", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    const faMsg = getMessages("fa");
    for (const ts of ["2026-08-01T11:30:00Z", "2026-08-01T09:00:00Z",
                      "2026-07-20T12:00:00Z", "2026-08-05T12:00:00Z"]) {
      const out = fmtAge(ts, faMsg, now);
      expect(out).not.toMatch(/[۰-۹٠-٩]/);
      expect(out).not.toMatch(/\bago\b|\bin\b/);
      expect(out).toMatch(/\d+[mhd]/);
    }
  });

  it("fmtAge still renders each unit band", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    expect(fmtAge("2026-08-01T11:30:00Z", en, now)).toBe("30m ago");
    expect(fmtAge("2026-08-01T09:00:00Z", en, now)).toBe("3h ago");
    expect(fmtAge("2026-07-20T12:00:00Z", en, now)).toBe("12d ago");
  });

  it("fmtAge returns the raw string for an unparseable timestamp", () => {
    expect(fmtAge("not-a-date", en, new Date("2026-08-01T12:00:00Z"))).toBe("not-a-date");
  });
  it("cls joins truthy parts", () => {
    expect(cls("a", false, "b", undefined)).toBe("a b");
  });
});
