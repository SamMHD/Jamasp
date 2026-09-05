"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isActive, OVERFLOW } from "@/lib/nav";
import { NavItemBody } from "@/components/shell/nav-pending";
import { cls } from "@/lib/format";

/** The destinations that do not earn a tab slot. Uses the existing radix
 *  dialog rather than adding a sheet dependency. */
export function MoreSheet({ open, onOpenChange }: {
  open: boolean; onOpenChange: (value: boolean) => void;
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
        <DialogHeader><DialogTitle>More</DialogTitle></DialogHeader>
        <nav aria-label="More sections" className="flex flex-col gap-0.5">
          {OVERFLOW.map(({ href, label, icon: Icon }) => {
            const active = isActive(path, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                // Tapping the row that is already current changes no
                // pathname, so the effect above will never fire for it —
                // that one still closes on the tap.
                onClick={() => { if (active) onOpenChange(false); }}
                className={cls(
                  "flex min-h-11 items-center gap-3 rounded-md px-3 text-body",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  active ? "bg-secondary font-medium text-primary"
                         : "text-foreground hover:bg-secondary",
                )}
              >
                <NavItemBody icon={Icon} label={label} />
              </Link>
            );
          })}
        </nav>
      </DialogContent>
    </Dialog>
  );
}
