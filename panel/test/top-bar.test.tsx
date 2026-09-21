import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import fa from "@/messages/fa.json";

const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));
// TopBar now renders LangToggle, which calls the server action setLocale on
// click — never exercised by renderToStaticMarkup, but the import chain
// still pulls in @/lib/actions, which is worth stubbing rather than letting
// this test depend on next/cache and next/headers behaving outside a real
// request.
vi.mock("@/lib/actions", () => ({ setLocale: vi.fn() }));

const { TopBar } = await import("@/components/shell/top-bar");

type Tone = "fresh" | "stale" | "unknown";
const render = (path: string, tone: Tone = "fresh", messages: typeof en | typeof fa = en) => {
  pathname.current = path;
  return renderToStaticMarkup(
    <TopBar ingestTone={tone} locale={messages === fa ? "fa" : "en"} messages={messages} />);
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

  // These two dictionary keys were hand-translated in Task 1 but never
  // wired to any call site until now — an orphaned key means a surface was
  // missed, not that the key was spare (same finding class as Task 4's
  // nav.more). Asserted against the real fa.json.
  it("states the ingest tone from the dictionary in Persian, in the accessible name", () => {
    const html = render("/", "stale", fa);
    expect(html).toContain(fa["shell.ingestStale"]);
    expect(html).toContain(fa["nav.alerts"]);
    expect(html).not.toContain("ingest stale");
  });

  it("keeps the English wording in the English locale", () => {
    expect(render("/", "fresh", en)).toContain(en["shell.ingestFresh"]);
  });
});
