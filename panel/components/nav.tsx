"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cls } from "@/lib/format";

const LINKS = [
  ["/", "Overview"], ["/inbox", "Inbox"], ["/crawl", "Crawl"],
  ["/briefs", "Briefs"], ["/schedule", "Schedule"], ["/calendar", "Calendar"],
  ["/alerts", "Alerts"], ["/state", "State"], ["/prices", "Prices"],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <aside className="w-48 shrink-0 border-r border-border p-4">
      <div className="mb-6 text-lg font-bold text-primary">Jamasp</div>
      <nav className="flex flex-col gap-1">
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href}
            className={cls(
              "rounded px-3 py-1.5 text-sm hover:bg-accent",
              (href === "/" ? path === "/" : path.startsWith(href)) &&
                "bg-accent font-medium text-primary",
            )}>
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
