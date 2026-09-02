"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ALL, isActive } from "@/lib/nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { cls } from "@/lib/format";

const DOT = {
  fresh: "bg-up",
  stale: "bg-destructive",
  unknown: "bg-muted-foreground",
} as const;

/**
 * Mobile header, rendered below 1024px only.
 *
 * The status indicator reports ingest freshness and links to /alerts — it is
 * the reason Alerts does not occupy one of the four tab slots. Its tone is
 * stated in the accessible name as well as the dot colour, because a dot is
 * colour alone.
 */
export function TopBar({ ingestTone }: { ingestTone: "fresh" | "stale" | "unknown" }) {
  const path = usePathname();
  const current = ALL.find(i => isActive(path, i.href));
  return (
    <header
      className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur
                 pt-[env(safe-area-inset-top)] lg:hidden"
    >
      <div className="flex h-14 items-center gap-3 px-3">
        <span className="text-heading font-semibold text-primary">Jamasp</span>
        {current && (
          <span className="truncate text-body text-muted-foreground">{current.label}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Link
            href="/alerts"
            aria-label={`Alerts — ingest ${ingestTone}`}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md
                       hover:bg-secondary focus-visible:outline-2
                       focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className={cls("h-2.5 w-2.5 rounded-full", DOT[ingestTone])} aria-hidden="true" />
          </Link>
          <ThemeToggle />
        </span>
      </div>
    </header>
  );
}
