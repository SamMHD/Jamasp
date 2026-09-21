import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EconomicCalendarWidget } from "@/components/tradingview-embed";
import { getEvents } from "@/lib/db";
import { fmtDubai, fmtUtc } from "@/lib/format";
import { TV_CALENDAR_COUNTRIES } from "@/lib/tradingview";

export const dynamic = "force-dynamic";

function dubaiDay(ts: string): string {
  return new Date(new Date(ts).getTime() + 4 * 3600_000).toISOString().slice(0, 10);
}

export default function CalendarPage() {
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

      <section aria-label="What Jamasp is watching" className="mb-8">
        <h2 className="mb-3 text-label uppercase text-ink-dim">
          What Jamasp is watching
        </h2>
        {events.length === 0 && <p className="text-sm text-muted-foreground">nothing upcoming</p>}
        {[...byDay.entries()].map(([day, evs]) => (
          <section key={day} className="mb-6">
            <h3 className="mb-2 font-medium">{day} <span className="text-xs text-muted-foreground">(Dubai)</span></h3>
            <ul className="space-y-1 text-sm">
              {evs.map(e => (
                <li key={e.id} className="flex items-center gap-2">
                  <span className="w-40 text-muted-foreground">{fmtUtc(e.starts_at)} · {fmtDubai(e.starts_at)}</span>
                  {e.impact && (
                    <Badge variant={e.impact.toLowerCase() === "high" ? "destructive" : "outline"}>
                      {e.impact}
                    </Badge>
                  )}
                  <span>{e.title}</span>
                  {e.country && <span className="text-xs text-muted-foreground">{e.country}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </section>

      {/*
        Reference data, under Jamasp's own list and clearly separated from it.

        These two calendars are not redundant, and the distinction is worth
        the space: the list above is what Jamasp INGESTED — the ff_calendar
        source, which ships one week at a time (docs/todo/001), so Jamasp's
        horizon runs out at the end of the current week, every week, and those
        are the events its briefs and scans can actually reason about. The
        widget below is TradingView's own feed, sees past that edge, and
        reasons about nothing.

        Ordering carries the same message: Jamasp first, always.
      */}
      <Panel
        title="Reference — TradingView economic calendar"
        aria-label="TradingView economic calendar"
        footer={
          <>
            Source: TradingView, live. Medium and high impact only, filtered to{" "}
            {TV_CALENDAR_COUNTRIES.join(", ").toUpperCase()}{" "}
            — the economies behind Jamasp&rsquo;s own sources. Times are the
            widget&rsquo;s own, not the UTC/Dubai pair used above.
          </>
        }
      >
        <p className="mb-3 text-body text-muted-foreground">
          Jamasp&rsquo;s list stops at the end of the current week — that is the
          horizon of the feed it ingests. This is the longer view, for planning
          rather than analysis: nothing here has been read, scored or weighted
          by Jamasp, and an event only enters a brief once it appears above.
        </p>
        <EconomicCalendarWidget />
      </Panel>
    </div>
  );
}
