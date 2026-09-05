"use client";

import { useLinkStatus } from "next/link";
import { LoaderCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cls } from "@/lib/format";

/**
 * Click feedback for the shell's navigation links.
 *
 * `loading.tsx` handles the common case: the fallback is prefetched, so the
 * router can swap it in the same frame as the click. But prefetching is
 * exactly what a bad connection fails to finish — which is the connection
 * the desk complained about — and until the fallback has arrived the router
 * has nothing to paint and the click reads as ignored. `useLinkStatus` is
 * the documented cover for that window: it reports the pending state of the
 * *enclosing* `<Link>`, so it must be rendered as a descendant of one.
 * See node_modules/next/dist/docs/01-app/03-api-reference/04-functions/
 * use-link-status.md.
 *
 * The hint is deliberately not instant. It starts transparent and fades in
 * after 120ms (`nav-hint-*` in app/globals.css), so a fast transition — the
 * normal case on the office LAN — completes before anything appears rather
 * than strobing a spinner for one frame. The delay is in CSS, not a
 * `setTimeout`, so React never re-renders to reveal it.
 *
 * Feedback is never colour alone: the icon turns into a moving spinner and
 * the label goes gold, and the live region states which destination is
 * loading for a reader who sees neither.
 */

/** Icon slot that cross-fades to a spinner while its `<Link>` is pending. */
function PendingIcon({ icon: Icon, size, pending }: {
  icon: LucideIcon; size: string; pending: boolean;
}) {
  return (
    <span className={cls("relative inline-flex shrink-0 items-center justify-center", size)}>
      <Icon
        aria-hidden="true"
        className={cls("h-full w-full", pending && "nav-hint-out")}
      />
      {pending && (
        <span className="nav-hint-in absolute inset-0 text-primary">
          <LoaderCircle aria-hidden="true" className="h-full w-full animate-spin" />
        </span>
      )}
    </span>
  );
}

/**
 * Icon + label for a nav `<Link>`, rendered as a fragment so the enclosing
 * link keeps deciding the direction (a row in the sidebar and the More
 * sheet, a column in the tab bar) and the spacing.
 */
export function NavItemBody({ icon, label, size = "h-4 w-4" }: {
  icon: LucideIcon; label: string; size?: string;
}) {
  const { pending } = useLinkStatus();
  return (
    <>
      <PendingIcon icon={icon} size={size} pending={pending} />
      {/* `nav-hint-label` carries the gold itself, on the same delay as the
          spinner — see app/globals.css. */}
      <span className={cls(pending && "nav-hint-label")}>{label}</span>
      {/* One live region per link. Empty when idle, so nothing is announced
          until a navigation is actually in flight. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? `Loading ${label}…` : ""}
      </span>
    </>
  );
}

/**
 * The top bar's status dot, which doubles as the Alerts link. The dot's
 * colour is ingest freshness, so it cannot also carry "loading" — the
 * spinner replaces it outright for the duration instead of tinting it, and
 * the link's accessible name still states the tone.
 */
export function NavPendingDot({ className }: { className: string }) {
  const { pending } = useLinkStatus();
  if (pending) {
    return (
      <>
        <span className="nav-hint-in inline-flex h-4 w-4 text-primary">
          <LoaderCircle aria-hidden="true" className="h-full w-full animate-spin" />
        </span>
        <span role="status" aria-live="polite" className="sr-only">Loading Alerts…</span>
      </>
    );
  }
  return <span className={className} aria-hidden="true" />;
}
