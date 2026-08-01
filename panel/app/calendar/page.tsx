import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { getEvents } from "@/lib/db";
import { fmtDubai, fmtUtc } from "@/lib/format";

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
      {events.length === 0 && <p className="text-sm text-muted-foreground">nothing upcoming</p>}
      {[...byDay.entries()].map(([day, evs]) => (
        <section key={day} className="mb-6">
          <h2 className="mb-2 font-medium">{day} <span className="text-xs text-muted-foreground">(Dubai)</span></h2>
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
    </div>
  );
}
