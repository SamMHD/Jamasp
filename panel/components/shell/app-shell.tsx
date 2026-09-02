import { SideNav } from "@/components/shell/side-nav";
import { TabBar } from "@/components/shell/tab-bar";
import { TopBar } from "@/components/shell/top-bar";
import { getMeta } from "@/lib/db";

export type IngestTone = "fresh" | "stale" | "unknown";

/**
 * Ingest freshness for the shell's status indicator. Same 60-minute rule as
 * StatusStrip, so the two cannot disagree.
 *
 * `unknown` is distinct from `stale`: a host that has never ingested has not
 * gone stale, and reporting either state as the other would be a status the
 * data does not support.
 */
export function ingestTone(lastIngest: string | null, now: Date): IngestTone {
  if (!lastIngest) return "unknown";
  const t = new Date(lastIngest).getTime();
  if (Number.isNaN(t)) return "unknown";
  return now.getTime() - t > 60 * 60_000 ? "stale" : "fresh";
}

/**
 * Sidebar at >=1024px; top bar plus bottom tab bar below it. The breakpoint
 * is deliberately late — a full layout is preferable for as long as it fits.
 *
 * The tab bar is `position: fixed`, so it never occupies flex space — it
 * simply paints over whatever is at the bottom of the viewport, and <main>
 * needs bottom padding to keep its last row out from under it. That
 * padding can't just be the bar's own `min-h-14` (56px) floor: the bar's
 * *rendered* height is `max(56px, 49px + env(safe-area-inset-bottom))` —
 * 44px per-item floor + 4px top padding + 1px top border, plus whatever the
 * safe-area inset adds beneath that — and the 56px floor stops binding once
 * the inset passes ~7px. At the standard 34px iOS home-indicator inset
 * that's 83px, which a flat `pb-20` (80px) undershoots by 3px (confirmed by
 * rendering the bar's exact markup and measuring it, not by trusting the
 * arithmetic). Padding by the same `env(safe-area-inset-bottom)` term the
 * bar itself pads with — rather than a constant tuned to one inset value —
 * tracks any device's real inset instead of quietly clipping again on the
 * next one, with ~8px of breathing room to spare above the bar itself.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const tone = ingestTone(getMeta("last_ingest_at"), new Date());
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50
                   focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-body
                   focus:outline-2 focus:outline-ring"
      >
        Skip to content
      </a>
      <TopBar ingestTone={tone} />
      <SideNav />
      <main
        id="main"
        className="min-w-0 flex-1 px-4 pt-4 pb-[calc(4rem_+_env(safe-area-inset-bottom))]
                   lg:px-6 lg:pt-6 lg:pb-6"
      >
        {children}
      </main>
      <TabBar />
    </div>
  );
}
