import {
  Bell, CalendarDays, Clock, FileText, Gauge, Inbox, LineChart, Radio, Rss,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };

/**
 * The four destinations worth a tab slot on a phone. Alerts is deliberately
 * not among them: the top bar's status dot already links there and reports
 * ingest freshness ("fresh" | "stale" | "unknown", from one getMeta read),
 * so the alerting path stays one tap away without spending a slot.
 */
export const PRIMARY: NavItem[] = [
  { href: "/", label: "Overview", icon: Gauge },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/briefs", label: "Briefs", icon: FileText },
  { href: "/schedule", label: "Schedule", icon: Clock },
];

export const OVERFLOW: NavItem[] = [
  { href: "/crawl", label: "Crawl", icon: Rss },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/state", label: "State", icon: Radio },
  { href: "/prices", label: "Prices", icon: LineChart },
];

export const ALL: NavItem[] = [...PRIMARY, ...OVERFLOW];

/** Prefix match, but only at a path boundary — "/pricesomething" is not
 *  inside "/prices". The overview matches exactly or every route is active. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
