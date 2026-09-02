import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

const { TopBar } = await import("@/components/shell/top-bar");

type Tone = "fresh" | "stale" | "unknown";
const render = (path: string, tone: Tone = "fresh") => {
  pathname.current = path;
  return renderToStaticMarkup(<TopBar ingestTone={tone} />);
};

describe("TopBar", () => {
  it("names the current page", () => {
    expect(render("/inbox")).toContain("Inbox");
    expect(render("/briefs/2026/07/2026-07-31-brief")).toContain("Briefs");
  });

  it("falls back to the wordmark alone on an unknown route", () => {
    const html = render("/nowhere");
    expect(html).toContain("Jamasp");
    // Guard audit: `{current && (<span>...)}` — this only proved the
    // unconditional wordmark renders, which would still pass even if
    // `current` wrongly matched some other route's label. The label span
    // itself (not any individual label string, which could coincidentally
    // appear elsewhere, e.g. in an aria-label) must be entirely absent.
    expect(html).not.toContain('class="truncate text-body text-muted-foreground"');
  });

  // The status indicator is why Alerts does not need a tab slot, so it must
  // actually link there.
  it("links the status indicator to alerts", () => {
    expect(render("/")).toContain('href="/alerts"');
  });

  // Never colour alone: the tone is also stated in the accessible name.
  it("states the ingest tone in words, not just colour", () => {
    expect(render("/", "stale")).toContain("stale");
    expect(render("/", "fresh")).toContain("fresh");
  });

  it("respects the top safe area", () => {
    expect(render("/")).toContain("pt-[env(safe-area-inset-top)]");
  });
});
