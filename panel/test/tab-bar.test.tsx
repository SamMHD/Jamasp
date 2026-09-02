import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

const { TabBar } = await import("@/components/shell/tab-bar");

const render = (path: string) => {
  pathname.current = path;
  return renderToStaticMarkup(<TabBar />);
};

describe("TabBar", () => {
  it("shows the four primary destinations plus More", () => {
    const html = render("/");
    for (const label of ["Overview", "Inbox", "Briefs", "Schedule", "More"]) {
      expect(html).toContain(label);
    }
  });

  it("does not put overflow destinations in the bar itself", () => {
    const html = render("/");
    // Crawl, Calendar, State and Prices live in the sheet, which is closed.
    for (const label of ["Crawl", "Calendar", "Prices"]) {
      expect(html).not.toContain(`>${label}<`);
    }
  });

  it("marks the active tab with aria-current", () => {
    expect(render("/inbox")).toContain('aria-current="page"');
  });

  // Every target must clear 44pt. min-h-14 (56px) on the bar plus min-h-11
  // (44px) per item is the floor this plan sets.
  it("gives every tab a 44px minimum target", () => {
    const html = render("/");
    expect(html).toContain("min-h-11");
  });

  // The bar's own floor must be 56px, not just each item's 44px — a bar with
  // no explicit height would shrink to fit its shortest content (icon +
  // label ≈ 35px), and min-h-11 alone was already meeting that shorter
  // floor. min-h-14 (not the fixed h-14 the sibling top bar uses) so the
  // safe-area inset grows the bar instead of eating into it.
  it("gives the bar itself a 56px floor", () => {
    expect(render("/")).toContain("min-h-14");
  });

  it("respects the bottom safe area", () => {
    expect(render("/")).toContain("pb-[env(safe-area-inset-bottom)]");
  });
});
