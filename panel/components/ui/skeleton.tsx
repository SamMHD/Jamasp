import { cls } from "@/lib/format";

/**
 * Loading placeholders for the route-level `loading.tsx` fallbacks.
 *
 * Why skeletons rather than a spinner: every panel route is dynamic
 * (`force-dynamic`), so Next.js can only *partially* prefetch it — and only
 * when the segment has a `loading.tsx`. That fallback is what turns a click
 * into an instant paint; without one the router holds the old page on screen
 * for the whole server round trip and the click reads as ignored. Since the
 * fallback is prefetched and free, it may as well carry the destination's
 * real shape: a reader who sees the map slot, the two-column grid and the
 * panel stack knows which page is arriving, and the wait stops reading as a
 * hang. See node_modules/next/dist/docs/01-app/01-getting-started/
 * 04-linking-and-navigating.md ("Dynamic routes without loading.tsx").
 *
 * Everything here is presentational and inert. The fallback root carries the
 * announcement (`role="status"`); the bars themselves are `aria-hidden` so a
 * screen reader hears "Loading Overview", not eleven anonymous boxes.
 *
 * `motion-safe:` on the pulse: a full page of synchronised pulsing is
 * exactly the kind of motion a reduced-motion reader asked not to receive.
 * Without it the placeholder still reads as a placeholder — it is a flat
 * block of `--secondary` where content will be.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cls("motion-safe:animate-pulse rounded bg-secondary", className)}
    />
  );
}

/** A run of text lines, last one short so it reads as a paragraph. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cls("space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cls("h-3", i === lines - 1 ? "w-2/5" : "w-full")} />
      ))}
    </div>
  );
}

/**
 * A bordered card matching components/ui/panel.tsx's frame, so the fallback
 * occupies the same box the real panel will.
 */
export function SkeletonPanel({ lines = 4, title = true, className }: {
  lines?: number; title?: boolean; className?: string;
}) {
  return (
    <section className={cls("rounded border border-border p-4", className)}>
      {title && <Skeleton className="mb-3 h-4 w-32" />}
      <SkeletonText lines={lines} />
    </section>
  );
}

/**
 * The page title block every route opens with (components/page-header.tsx),
 * so the top of the screen does not jump when the real header lands.
 */
export function SkeletonPageHeader({ subtitle = true }: { subtitle?: boolean }) {
  return (
    <div className="mb-4">
      <Skeleton className="h-7 w-48" />
      {subtitle && <Skeleton className="mt-2 h-3 w-64" />}
    </div>
  );
}

/** Rows of a table or list, at the row height the real tables use. */
export function SkeletonRows({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={cls("space-y-2", className)}>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
    </div>
  );
}

/**
 * The frame every `loading.tsx` wraps itself in: names the destination for a
 * screen reader, and marks the region busy so assistive tech reports the
 * wait rather than reading a screen of empty boxes.
 */
export function SkeletonPage({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-label={`Loading ${label}`}>
      <span className="sr-only">Loading {label}…</span>
      {children}
    </div>
  );
}
