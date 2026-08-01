import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { RunBadge } from "@/components/run-badge";
import * as db from "@/lib/db";
import * as files from "@/lib/files";
import { deriveSourceHealth, deriveWarnings } from "@/lib/health";
import { fmtAge, fmtDubai, fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function Overview() {
  const now = new Date();
  const sinceIso = new Date(now.getTime() - 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const lastIngest = db.getMeta("last_ingest_at");
  const sources = files.loadSources();
  const lastFetch = Object.fromEntries(
    sources.map(s => [s.name, db.getMeta(`source_last_fetch.${s.name}`)]));
  const lastItems = Object.fromEntries(
    db.lastItemPerSource().map(r => [r.source, r.last]));
  const sourceErrors = db.getSourceErrors(sinceIso);
  const health = deriveSourceHealth(sources, lastFetch, lastItems,
    sourceErrors, now);
  const runsToday = db.runsTodayDubai(now);
  const cap = files.maxRunsPerDay();
  const recentRuns = db.getAgentRuns(50);
  const warnings = deriveWarnings({ lastIngestAt: lastIngest,
    runs: recentRuns, sourceHealth: health, runsToday, cap }, now);
  const prices = db.getPriceSnapshots(now);
  const wakeups = db.getWakeups("pending").slice(0, 3);
  const events = db.getEvents(14, now).slice(0, 3);
  const lastAlert = db.getNotifyLog(1)[0];
  const lastRuns = db.lastRunPerType();
  const lastByType = ["brief", "scan", "deepdive", "retro"].map(t =>
    [t, lastRuns.find(r => r.run_type === t)] as const);

  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Overview" subtitle={`as of ${fmtUtc(now.toISOString())}`} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Last ingest" value={lastIngest ? fmtAge(lastIngest, now) : "never"}
          tone={warnings.some(w => w.text.startsWith("ingest stale")) ? "bad" : "ok"} />
        <StatCard label="Runs today" value={`${runsToday}/${cap}`}
          tone={runsToday >= cap ? "warn" : undefined} />
        <StatCard label="Unread items" value={String(db.getUnreadCount())} />
        <StatCard label="Source errors 24h" value={String(sourceErrors.length)}
          tone={sourceErrors.length ? "warn" : "ok"} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {prices.length === 0 && <p className="text-sm text-muted-foreground">no price snapshots yet</p>}
        {prices.map(p => (
          <StatCard key={p.symbol} label={p.symbol} value={p.value.toLocaleString()}
            sub={`24h ${p.delta24h == null ? "—" : p.delta24h.toFixed(1)} · 7d ${p.delta7d == null ? "—" : p.delta7d.toFixed(1)}`} />
        ))}
      </div>
      {warnings.length > 0 && (
        <div className="mt-6 space-y-2">
          {warnings.map((w, i) => (
            <div key={i} className={w.severity === "red"
              ? "rounded border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
              : "rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-sm text-amber-300"}>
              {w.text}
            </div>
          ))}
        </div>
      )}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section>
          <h2 className="mb-2 font-medium">Last runs <Link className="text-xs text-primary" href="/schedule">→ schedule</Link></h2>
          <ul className="space-y-1 text-sm">
            {lastByType.map(([t, r]) => (
              <li key={t} className="flex justify-between">
                <span>{t}</span>
                {r ? <span><RunBadge status={r.status} />
                  <span className="ml-2 text-muted-foreground">{fmtAge(r.started_at, now)}</span></span>
                  : <span className="text-muted-foreground">never</span>}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 font-medium">Next wakeups <Link className="text-xs text-primary" href="/schedule">→ all</Link></h2>
          <ul className="space-y-1 text-sm">
            {wakeups.length === 0 && <li className="text-muted-foreground">none pending</li>}
            {wakeups.map(w => (
              <li key={w.id}>#{w.id} {w.run_type} {fmtAge(w.due_at, now)} — <span className="text-muted-foreground">{w.task}</span></li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 font-medium">Next events <Link className="text-xs text-primary" href="/calendar">→ calendar</Link></h2>
          <ul className="space-y-1 text-sm">
            {events.length === 0 && <li className="text-muted-foreground">nothing upcoming</li>}
            {events.map(e => (
              <li key={e.id}>{fmtUtc(e.starts_at)} ({fmtDubai(e.starts_at)}) — {e.title}</li>
            ))}
          </ul>
        </section>
      </div>
      {lastAlert && (
        <section className="mt-6">
          <h2 className="mb-2 font-medium">Latest alert <Link className="text-xs text-primary" href="/alerts">→ alerts</Link></h2>
          <p dir={/[؀-ۿ]/.test(lastAlert.text) ? "rtl" : "ltr"}
            className="rounded border border-border p-3 text-sm [font-family:Vazirmatn,Tahoma,sans-serif]">
            {lastAlert.text}
          </p>
        </section>
      )}
    </div>
  );
}
