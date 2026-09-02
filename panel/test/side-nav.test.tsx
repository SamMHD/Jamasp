import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

const { SideNav } = await import("@/components/shell/side-nav");

const render = (path: string) => {
  pathname.current = path;
  return renderToStaticMarkup(<SideNav />);
};

describe("SideNav", () => {
  it("lists all nine destinations with their labels", () => {
    const html = render("/");
    for (const label of ["Overview", "Inbox", "Briefs", "Schedule", "Crawl",
                         "Calendar", "Alerts", "State", "Prices"]) {
      expect(html).toContain(label);
    }
  });

  // Colour alone is not an acceptable state cue; aria-current is the cue that
  // reaches a screen reader and survives a colour-blind reader.
  it("marks the active route with aria-current", () => {
    expect(render("/inbox")).toContain('aria-current="page"');
  });

  it("marks only one route active at a time", () => {
    const html = render("/briefs/2026/07/2026-07-31-brief");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  // Extract the overview's own <a> tag rather than slicing between two href
  // occurrences. React emits aria-current BEFORE href — the rendered active
  // link is `<a aria-current="page" class="…" href="/inbox">` — so a slice
  // running from the overview's href to the inbox link's href swallows the
  // inbox link's aria-current and fails against a correct component.
  it("does not mark the overview active on a sub-route", () => {
    const overviewTag = render("/inbox").match(/<a\b[^>]*href="\/"[^>]*>/)![0];
    expect(overviewTag).not.toContain("aria-current");
  });

  // 44pt targets are a mobile rule, but a 40px row is the desktop floor this
  // plan sets and the old 30px rows failed even that.
  it("gives every row at least a 40px target", () => {
    expect(render("/")).toContain("h-10");
  });

  // The sidebar is the only chrome a desktop reader sees, so it carries the
  // appearance control — without it, desktop has no way to change theme.
  it("offers the appearance control", () => {
    expect(render("/")).toContain("Appearance:");
  });
});
