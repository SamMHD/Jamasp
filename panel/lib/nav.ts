import {
  Bell, CalendarDays, Clock, FileText, Gauge, Globe, Inbox, LineChart, Radio, Rss,
  Target,
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

/**
 * Everything else, in the "More" sheet on a phone and the sidebar on desktop.
 *
 * /markets is here rather than in PRIMARY, and the demotion is the point: it
 * is the only route in this panel that shows somebody else's analysis. A tab
 * slot next to Overview would have put third-party reference data at the same
 * rank as Jamasp's own read, which is exactly the confusion the page itself
 * is written to prevent. A Globe icon rather than a chart one, for the same
 * reason — nothing about it should look like the panel's own instruments.
 */
export const OVERFLOW: NavItem[] = [
  { href: "/crawl", label: "Crawl", icon: Rss },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/state", label: "State", icon: Radio },
  { href: "/predictions", label: "Predictions", icon: Target },
  { href: "/prices", label: "Prices", icon: LineChart },
  { href: "/markets", label: "Markets", icon: Globe },
];

export const ALL: NavItem[] = [...PRIMARY, ...OVERFLOW];

/** Prefix match, but only at a path boundary — "/pricesomething" is not
 *  inside "/prices". The overview matches exactly or every route is active. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
