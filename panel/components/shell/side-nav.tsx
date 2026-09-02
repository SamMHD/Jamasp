"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ALL, isActive } from "@/lib/nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { cls } from "@/lib/format";

/**
 * Desktop navigation, rendered at >=1024px only (AppShell hides it below).
 *
 * The active row carries three cues, not one: a gold left rule, gold text,
 * and a raised background. Colour alone would fail a colour-blind reader,
 * and aria-current carries it to a screen reader.
 *
 * The appearance control lives in the header row: this sidebar is the only
 * chrome a desktop reader sees, so without it desktop has no way to change
 * theme at all.
 */
export function SideNav() {
  const path = usePathname();
  return (
    <aside className="hidden w-56 shrink-0 border-r border-border bg-card lg:block">
      <div className="flex h-14 items-center gap-2 px-2 pl-4">
        <span className="text-heading font-semibold text-primary">Jamasp</span>
        <span className="ml-auto"><ThemeToggle /></span>
      </div>
      <nav aria-label="Sections" className="flex flex-col gap-0.5 px-2 pb-4">
        {ALL.map(({ href, label, icon: Icon }) => {
          const active = isActive(path, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cls(
                "flex h-10 items-center gap-2.5 rounded-md border-l-2 px-3 text-body",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                active
                  ? "border-l-primary bg-secondary font-medium text-primary"
                  : "border-l-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
