"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isActive, OVERFLOW } from "@/lib/nav";
import { cls } from "@/lib/format";

/** The destinations that do not earn a tab slot. Uses the existing radix
 *  dialog rather than adding a sheet dependency. */
export function MoreSheet({ open, onOpenChange }: {
  open: boolean; onOpenChange: (value: boolean) => void;
}) {
  const path = usePathname();
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
                onClick={() => onOpenChange(false)}
                className={cls(
                  "flex min-h-11 items-center gap-3 rounded-md px-3 text-body",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  active ? "bg-secondary font-medium text-primary"
                         : "text-foreground hover:bg-secondary",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {label}
              </Link>
            );
          })}
        </nav>
      </DialogContent>
    </Dialog>
  );
}
