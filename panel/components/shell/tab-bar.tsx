"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ellipsis } from "lucide-react";
import { isActive, OVERFLOW, PRIMARY } from "@/lib/nav";
import { MoreSheet } from "@/components/shell/more-sheet";
import { cls } from "@/lib/format";

const ITEM = "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 " +
  "rounded-md px-1 text-label focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Primary navigation below 1024px. Bottom placement is the platform
 * convention for a phone's primary nav, and it keeps the targets inside
 * comfortable thumb reach.
 */
export function TabBar() {
  const path = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const overflowActive = OVERFLOW.some(i => isActive(path, i.href));

  return (
    <>
      {/* min-h-14 (56px), not h-14: a fixed h-14 is a total height under
          border-box, so the safe-area bottom padding below would eat into
          the row on a notched phone and squeeze items back under 44px.
          min-h-14 is a floor the bar grows past instead. */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex min-h-14 items-stretch gap-1 border-t
                   border-border bg-card px-1 pt-1 pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {PRIMARY.map(({ href, label, icon: Icon }) => {
          const active = isActive(path, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cls(ITEM, active ? "text-primary" : "text-muted-foreground")}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              {label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={cls(ITEM, overflowActive ? "text-primary" : "text-muted-foreground")}
        >
          <Ellipsis className="h-5 w-5" aria-hidden="true" />
          More
        </button>
      </nav>
      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} />
    </>
  );
}
