import {
  Bell, CalendarDays, Clock, FileText, Gauge, Inbox, LineChart, Radio, Rss, Target,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = { href: string; labelKey: string; icon: LucideIcon };

/**
 * The four destinations worth a tab slot on a phone. Alerts is deliberately
 * not among them: the top bar's status dot already links there and reports
 * ingest freshness ("fresh" | "stale" | "unknown", from one getMeta read),
 * so the alerting path stays one tap away without spending a slot.
 */
export const PRIMARY: NavItem[] = [
  { href: "/", labelKey: "nav.overview", icon: Gauge },
  { href: "/inbox", labelKey: "nav.inbox", icon: Inbox },
  { href: "/briefs", labelKey: "nav.briefs", icon: FileText },
  { href: "/schedule", labelKey: "nav.schedule", icon: Clock },
];

export const OVERFLOW: NavItem[] = [
  { href: "/crawl", labelKey: "nav.crawl", icon: Rss },
  { href: "/calendar", labelKey: "nav.calendar", icon: CalendarDays },
  { href: "/alerts", labelKey: "nav.alerts", icon: Bell },
  { href: "/state", labelKey: "nav.state", icon: Radio },
  { href: "/predictions", labelKey: "nav.predictions", icon: Target },
  { href: "/prices", labelKey: "nav.prices", icon: LineChart },
];

export const ALL: NavItem[] = [...PRIMARY, ...OVERFLOW];

/** Prefix match, but only at a path boundary — "/pricesomething" is not
 *  inside "/prices". The overview matches exactly or every route is active. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
