import { describe, expect, it } from "vitest";
import { localized } from "@/lib/i18n";

const row = { headline: "Gold climbs", headline_fa: "طلا بالا رفت", lede: "Bullion rose.", lede_fa: null };

describe("localized", () => {
  it("returns English unchanged in English", () => {
    expect(localized(row, "headline", "en")).toEqual({ text: "Gold climbs", fallback: false });
  });

  it("returns Persian when it exists", () => {
    expect(localized(row, "headline", "fa")).toEqual({ text: "طلا بالا رفت", fallback: false });
  });

  it("falls back to English and says so", () => {
    // The flag is the whole point: a component cannot render the English
    // and forget to mark it, because it has to destructure `fallback` to
    // get the text at all.
    expect(localized(row, "lede", "fa")).toEqual({ text: "Bullion rose.", fallback: true });
  });

  it("treats blank Persian as absent", () => {
    expect(localized({ headline: "H", headline_fa: "   " }, "headline", "fa"))
      .toEqual({ text: "H", fallback: true });
  });

  it("never reports a fallback in English, even with no Persian", () => {
    // English is not a degraded state when English is what was asked for.
    expect(localized({ headline: "H" }, "headline", "en").fallback).toBe(false);
  });

  it("yields empty text rather than throwing on a missing field", () => {
    expect(localized({}, "headline", "fa")).toEqual({ text: "", fallback: false });
  });
});
