import { cookies } from "next/headers";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { SourceLang } from "@/components/source-lang";
import { Badge } from "@/components/ui/badge";
import { getEvents } from "@/lib/db";
import { fmtDubai, fmtUtc } from "@/lib/format";
import { getMessages, LANG_COOKIE, localized, resolveLocale, t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

function dubaiDay(ts: string): string {
  return new Date(new Date(ts).getTime() + 4 * 3600_000).toISOString().slice(0, 10);
}

/**
 * `impact` is a closed enum (high/medium/low), not free text pulled from a
 * source — that makes it chrome, hand-translated here, rather than content
 * routed through `localized`/the translate job. A value outside the three
 * known ones (there shouldn't be any) renders as-is: a calendar row silently
 * dropping its impact badge is worse than one showing an unlocalized string.
 */
const IMPACT_KEYS: Record<string, string> = {
  high: "calendar.impactHigh",
  medium: "calendar.impactMedium",
  low: "calendar.impactLow",
};

export default async function CalendarPage() {
  // Resolved here, not lower in the tree: same pattern as app/page.tsx and
  // app/inbox/page.tsx — the locale cookie is httpOnly, so only a server
  // component may read it.
  const locale = resolveLocale((await cookies()).get(LANG_COOKIE)?.value);
  const messages = getMessages(locale);

  const now = new Date();
  const events = getEvents(30, now);
  const byDay = new Map<string, typeof events>();
  for (const e of events) {
    const d = dubaiDay(e.starts_at);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(e);
  }
  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Calendar" subtitle={`${events.length} events in the next 30 days`} />
      {events.length === 0 && <p className="text-sm text-muted-foreground">nothing upcoming</p>}
      {[...byDay.entries()].map(([day, evs]) => (
        <section key={day} className="mb-6">
          <h2 className="mb-2 font-medium">{day} <span className="text-xs text-muted-foreground">(Dubai)</span></h2>
          <ul className="space-y-1 text-sm">
            {evs.map(e => {
              // Times, the Dubai column and the country code are Latin/Gregorian
              // in both locales on purpose (spec decision 9) — only the title
              // goes through `localized`, and `impact` through the dictionary.
              const { text, fallback } = localized(e, "title", locale);
              const impactKey = e.impact ? IMPACT_KEYS[e.impact.toLowerCase()] : undefined;
              return (
                <li key={e.id} className="flex items-center gap-2">
                  <span className="w-40 text-muted-foreground">{fmtUtc(e.starts_at)} · {fmtDubai(e.starts_at)}</span>
                  {e.impact && (
                    <Badge variant={e.impact.toLowerCase() === "high" ? "destructive" : "outline"}>
                      {impactKey ? t(messages, impactKey) : e.impact}
                    </Badge>
                  )}
                  <span><SourceLang fallback={fallback} messages={messages}>{text}</SourceLang></span>
                  {e.country && <span className="text-xs text-muted-foreground">{e.country}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
