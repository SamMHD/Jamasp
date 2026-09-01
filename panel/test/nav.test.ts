import { describe, expect, it } from "vitest";
import { ALL, isActive, OVERFLOW, PRIMARY } from "@/lib/nav";

describe("nav model", () => {
  it("covers all nine routes exactly once", () => {
    const hrefs = ALL.map(i => i.href);
    expect(hrefs.sort()).toEqual([
      "/", "/alerts", "/briefs", "/calendar", "/crawl",
      "/inbox", "/prices", "/schedule", "/state",
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
      .toEqual(["/alerts", "/calendar", "/crawl", "/prices", "/state"]);
  });

  it("gives every destination an icon and a label", () => {
    for (const item of ALL) {
      expect(item.label.length, `${item.href} has no label`).toBeGreaterThan(0);
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
