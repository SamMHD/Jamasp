import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import { ALL, isActive, OVERFLOW, PRIMARY } from "@/lib/nav";

describe("nav model", () => {
  it("covers all ten routes exactly once", () => {
    const hrefs = ALL.map(i => i.href);
    expect(hrefs.sort()).toEqual([
      "/", "/alerts", "/briefs", "/calendar", "/crawl",
      "/inbox", "/predictions", "/prices", "/schedule", "/state",
    ]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  // Four primary destinations plus a "More" control fills a five-slot tab
  // bar without crowding the 44pt targets.
  it("keeps four primary destinations", () => {
    expect(PRIMARY.map(i => i.href)).toEqual(["/", "/inbox", "/briefs", "/schedule"]);
  });

  it("puts everything else in the overflow sheet", () => {
    expect(OVERFLOW.map(i => i.href).sort())
      .toEqual(["/alerts", "/calendar", "/crawl", "/predictions", "/prices", "/state"]);
  });

  it("gives every destination an icon and a label key", () => {
    for (const item of ALL) {
      expect(item.labelKey.length, `${item.href} has no label key`).toBeGreaterThan(0);
      expect(item.icon, `${item.href} has no icon`).toBeTruthy();
    }
  });
});

describe("isActive", () => {
  it("matches the overview only exactly", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/inbox", "/")).toBe(false);
  });
  it("matches a section by prefix", () => {
    expect(isActive("/briefs", "/briefs")).toBe(true);
    expect(isActive("/briefs/2026/07/2026-07-31-brief", "/briefs")).toBe(true);
  });
  // "/pricesomething" is not inside "/prices".
  it("does not match a sibling route that merely shares a prefix", () => {
    expect(isActive("/pricesomething", "/prices")).toBe(false);
  });
});

describe("nav labels", () => {
  it("names a dictionary key, not a literal", () => {
    for (const item of ALL) {
      expect(item.labelKey, `${item.href} must use a key`).toMatch(/^nav\./);
    }
  });

  it("has an English string for every nav key", () => {
    // A nav item whose key is absent renders as `nav.foo` in the tab bar,
    // which is the most visible place in the panel to get this wrong.
    for (const item of ALL) {
      expect(Object.keys(en)).toContain(item.labelKey);
    }
  });
});
