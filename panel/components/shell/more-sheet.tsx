"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isActive, OVERFLOW } from "@/lib/nav";
import { NavItemBody } from "@/components/shell/nav-pending";
import { cls } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Messages } from "@/lib/i18n";

/**
 * The overflow rows, exported so they can be rendered on their own.
 *
 * DialogContent sits inside a Radix Portal, which renders NOTHING under
 * renderToStaticMarkup (there is no document, and this project has no
 * jsdom) — so a static render of MoreSheet yields an empty string however
 * `open` is set. Lifting the rows out is the same escape hatch
 * components/inbox-table.tsx's ItemHeadline and
 * components/schedule-forms.tsx's RunTypeOptions use, and for the same
 * reason: one exported call site, rendered by the sheet and asserted
 * directly by test/more-sheet.test.tsx.
 *
 * `onNavigate` is the tap handler for the row that is ALREADY current —
 * see the call site's own comment for why that one closes on the tap.
 */
export function MoreSheetNav({ path, messages, onNavigate }: {
  path: string; messages: Messages; onNavigate: (active: boolean) => void;
}) {
  return (
    <nav aria-label={t(messages, "nav.moreSections")} className="flex flex-col gap-0.5">
      {OVERFLOW.map(({ href, labelKey, icon: Icon }) => {
        const active = isActive(path, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            // Tapping the row that is already current changes no
            // pathname, so the effect in MoreSheet will never fire for it —
            // that one still closes on the tap.
            onClick={() => onNavigate(active)}
            className={cls(
              "flex min-h-11 items-center gap-3 rounded-md px-3 text-body",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              active ? "bg-secondary font-medium text-primary"
                     : "text-foreground hover:bg-secondary",
            )}
          >
            <NavItemBody icon={Icon} label={t(messages, labelKey)} />
          </Link>
        );
      })}
    </nav>
  );
}

/** The destinations that do not earn a tab slot. Uses the existing radix
 *  dialog rather than adding a sheet dependency. */
export function MoreSheet({ open, onOpenChange, messages }: {
  open: boolean; onOpenChange: (value: boolean) => void; messages: Messages;
}) {
  const path = usePathname();

  // The sheet closes when the navigation LANDS, not when the row is tapped.
  // Closing on the tap dismissed the only surface carrying feedback — the
  // row's pending spinner — and dropped the reader back on the page they
  // were already looking at with nothing to show a tap had registered, which
  // is precisely the dead-click complaint this change exists to fix.
  //
  // The callback is held in a ref, refreshed by its own effect, so the
  // closing effect can depend on the pathname ALONE. Depending on
  // `onOpenChange` directly would work only for as long as every caller
  // passes a stable function: the day one passes an inline lambda the effect
  // re-runs every render and the sheet can never be opened at all. (The ref
  // is written in an effect rather than during render — react-hooks/refs.)
  const close = useRef(onOpenChange);
  useEffect(() => { close.current = onOpenChange; }, [onOpenChange]);
  useEffect(() => { close.current(false); }, [path]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>{t(messages, "nav.more")}</DialogTitle></DialogHeader>
        <MoreSheetNav path={path} messages={messages}
          onNavigate={active => { if (active) onOpenChange(false); }} />
      </DialogContent>
    </Dialog>
  );
}
