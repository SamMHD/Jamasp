import Link from "next/link";
import type { AgentRunRow, EventRow, NotifyLogRow, WakeupRow } from "@/lib/db";
import { cls, fmtAge, fmtDubai, fmtUtc } from "@/lib/format";

const RUN_TYPES = ["brief", "scan", "deepdive", "retro"] as const;

const DOT: Record<string, string> = {
  ok: "bg-emerald-400",
  failed: "bg-destructive",
  timeout: "bg-destructive",
  deferred: "bg-amber-400",
  // exited 0 but committed nothing: burnt a cap slot and produced no work,
  // so it needs attention like a failure — the tooltip separates the two.
  empty: "bg-destructive",
};

export function StatusStrip({ lastIngest, runsToday, cap, sourceErrors, lastRuns, now }: {
  lastIngest: string | null; runsToday: number; cap: number;
  sourceErrors: number; lastRuns: AgentRunRow[]; now: Date;
}) {
  const ingestStale = lastIngest === null
    || now.getTime() - new Date(lastIngest).getTime() > 60 * 60_000;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border px-3 py-2 text-xs">
      <Link href="/crawl" className="hover:underline">
        <span className="text-muted-foreground">ingest </span>
        <span className={cls("tabular-nums", ingestStale ? "text-destructive" : "text-emerald-400")}>
          {lastIngest ? fmtAge(lastIngest, now) : "never"}
        </span>
      </Link>
      <Link href="/schedule" className="hover:underline">
        <span className="text-muted-foreground">runs </span>
        <span className={cls("tabular-nums", runsToday >= cap && "text-amber-400")}>
          {runsToday}/{cap}
        </span>
      </Link>
      <Link href="/crawl" className="hover:underline">
        <span className="text-muted-foreground">errors 24h </span>
        <span className={cls("tabular-nums", sourceErrors > 0 ? "text-amber-400" : "text-emerald-400")}>
          {sourceErrors}
        </span>
      </Link>
      <div className="flex items-center gap-3">
        {RUN_TYPES.map(t => {
          const r = lastRuns.find(x => x.run_type === t);
          return (
            <Link key={t} href="/schedule" className="flex items-center gap-1 hover:underline"
              title={r ? `${t}: ${r.status}, ${fmtAge(r.started_at, now)}` : `${t}: never run`}>
              <span className={cls("inline-block h-2 w-2 rounded-full",
                r ? DOT[r.status] ?? "bg-muted-foreground" : "bg-muted-foreground/40")} />
              <span className="text-muted-foreground">{t}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function FooterStrip({ wakeup, event, lastAlert, now }: {
  wakeup: WakeupRow | undefined; event: EventRow | undefined;
  lastAlert: NotifyLogRow | undefined; now: Date;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border px-3 py-2 text-xs text-muted-foreground">
      <span>
        next wakeup:{" "}
        {wakeup
          ? <Link href="/schedule" className="text-foreground hover:underline">
              #{wakeup.id} {wakeup.run_type} {fmtAge(wakeup.due_at, now)}
            </Link>
          : "none pending"}
      </span>
      <span>
        next event:{" "}
        {event
          ? <Link href="/calendar" className="text-foreground hover:underline">
              {event.title} — {fmtUtc(event.starts_at)} ({fmtDubai(event.starts_at)})
            </Link>
          : "nothing upcoming"}
      </span>
      <span>
        last alert:{" "}
        {lastAlert
          ? <Link href="/alerts" className="text-foreground hover:underline">
              {fmtAge(lastAlert.ts, now)}
            </Link>
          : "none"}
      </span>
    </div>
  );
}
