import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import fa from "@/messages/fa.json";
import { DEFAULT_LOCALE, dirFor, getMessages, resolveLocale, t } from "@/lib/i18n";

describe("resolveLocale", () => {
  it("accepts a known locale", () => {
    expect(resolveLocale("fa")).toBe("fa");
    expect(resolveLocale("en")).toBe("en");
  });

  it("falls back to the default for anything else", () => {
    for (const v of [undefined, "", "de", "FA", "en-US", "../etc"]) {
      expect(resolveLocale(v)).toBe(DEFAULT_LOCALE);
    }
  });

  it("defaults to English in this PR", () => {
    // PR 3 flips this one constant and nothing else. A second hard-coded
    // default anywhere would make that flip incomplete and invisible.
    expect(DEFAULT_LOCALE).toBe("en");
  });
});

describe("t", () => {
  it("returns the string for a known key", () => {
    expect(t({ "nav.overview": "Overview" }, "nav.overview")).toBe("Overview");
  });

  it("falls back to English when a Persian key is missing", () => {
    const messages = getMessages("fa");
    expect(t({ ...messages, "nav.overview": "" }, "nav.overview"))
      .toBe(en["nav.overview" as keyof typeof en]);
  });

  it("falls back to the key itself when neither locale has it", () => {
    // A missing label must never render as blank space on a dense dashboard;
    // the key is ugly on purpose so it gets noticed and fixed.
    expect(t({}, "nav.nonexistent")).toBe("nav.nonexistent");
  });
});

describe("dictionary parity", () => {
  it("has a non-empty Persian string for every English key", () => {
    const missing = Object.keys(en).filter(
      k => !(k in fa) || !String(fa[k as keyof typeof fa]).trim());
    expect(missing).toEqual([]);
  });

  it("has no Persian key the English file lacks", () => {
    expect(Object.keys(fa).filter(k => !(k in en))).toEqual([]);
  });

  it("keeps Latin digits and tickers identical across locales", () => {
    // Spec decision 9. A Persian string that "localized" a number or a
    // ticker is a regression the desk reads as a typo.
    for (const [k, v] of Object.entries(fa)) {
      expect(String(v), `${k} must not use Persian-Indic digits`)
        .not.toMatch(/[۰-۹٠-٩]/);
    }
  });
});

describe("dirFor", () => {
  it("is rtl for Persian and ltr for English", () => {
    expect(dirFor("fa")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
  });
});
