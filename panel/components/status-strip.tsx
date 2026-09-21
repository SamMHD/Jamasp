import Link from "next/link";
import type { AgentRunRow, EventRow, NotifyLogRow, WakeupRow } from "@/lib/db";
import { cls, fmtAge, fmtDubai, fmtUtc } from "@/lib/format";
import { localized, t, type Locale, type Messages } from "@/lib/i18n";
import { SourceLang } from "@/components/source-lang";

const RUN_TYPES = ["brief", "scan", "deepdive", "retro"] as const;

// `runType.*` — the same dictionary keys components/run-badge.tsx#runTypeLabel
// reads. Not imported from there: that would be a component importing
// another component for a one-line t() call, the same shape of coupling the
// panel avoids elsewhere (lib/drivers.ts#driverLabel is a lib export for
// exactly this reason — see its own doc comment). Inlined instead.
const runTypeLabel = (runType: string, messages: Messages): string =>
  t(messages, `runType.${runType}`);

const DOT: Record<string, string> = {
  ok: "bg-up",
  failed: "bg-destructive",
  timeout: "bg-destructive",
  deferred: "bg-primary",
  // exited 0 but committed nothing: burnt a cap slot and produced no work,
  // so it needs attention like a failure — the tooltip separates the two.
  empty: "bg-destructive",
};

export function StatusStrip({ lastIngest, runsToday, cap, sourceErrors, lastRuns, now, messages }: {
  lastIngest: string | null; runsToday: number; cap: number;
  sourceErrors: number; lastRuns: AgentRunRow[]; now: Date; messages: Messages;
}) {
  const ingestStale = lastIngest === null
    || now.getTime() - new Date(lastIngest).getTime() > 60 * 60_000;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border px-3 py-2 text-xs">
      <Link href="/crawl" className="hover:underline">
        <span className="text-muted-foreground">{t(messages, "status.ingestWord")} </span>
        <span className={cls("tabular-nums", ingestStale ? "text-destructive" : "text-up")}>
          {lastIngest ? fmtAge(lastIngest, now) : t(messages, "common.never")}
        </span>
      </Link>
      <Link href="/schedule" className="hover:underline">
        <span className="text-muted-foreground">{t(messages, "status.runsWord")} </span>
        <span className={cls("tabular-nums", runsToday >= cap && "text-primary")}>
          {runsToday}/{cap}
        </span>
      </Link>
      <Link href="/crawl" className="hover:underline">
        <span className="text-muted-foreground">{t(messages, "table.errors24h").toLowerCase()} </span>
        <span className={cls("tabular-nums", sourceErrors > 0 ? "text-primary" : "text-up")}>
          {sourceErrors}
        </span>
      </Link>
      <div className="flex items-center gap-3">
        {RUN_TYPES.map(runType => {
          const r = lastRuns.find(x => x.run_type === runType);
          // .toLowerCase(): this strip's own convention is all-lowercase
          // labels ("ingest", "runs", "errors 24h" above) — runType.* is
          // capitalized for /schedule's Badge-style chrome, so this keeps
          // that strip's register in Persian without adopting its casing
          // here. A no-op on the Persian string, which carries no case.
          const label = runTypeLabel(runType, messages).toLowerCase();
          return (
            <Link key={runType} href="/schedule" className="flex items-center gap-1 hover:underline"
              title={r ? `${label}: ${r.status}, ${fmtAge(r.started_at, now)}` : `${label}: ${t(messages, "status.neverRun")}`}>
              <span className={cls("inline-block h-2 w-2 rounded-full",
                r ? DOT[r.status] ?? "bg-muted-foreground" : "bg-muted-foreground/40")} />
              <span className="text-muted-foreground">{label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function FooterStrip({ wakeup, event, lastAlert, now, locale, messages }: {
  wakeup: WakeupRow | undefined; event: EventRow | undefined;
  lastAlert: NotifyLogRow | undefined; now: Date; locale: Locale; messages: Messages;
}) {
  const eventTitle = event ? localized(event, "title", locale) : null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border px-3 py-2 text-xs text-muted-foreground">
      <span>
        {t(messages, "status.nextWakeupPrefix")}{" "}
        {wakeup
          ? <Link href="/schedule" className="text-foreground hover:underline">
              {/* .toLowerCase(): this footer's own register is all-lowercase
                  ("next wakeup:", "none pending") — see StatusStrip's
                  identical call for the same reasoning. */}
              #{wakeup.id} {runTypeLabel(wakeup.run_type, messages).toLowerCase()} {fmtAge(wakeup.due_at, now)}
            </Link>
          : t(messages, "status.noneWakeupPending")}
      </span>
      <span>
        {t(messages, "status.nextEventPrefix")}{" "}
        {event && eventTitle
          ? <Link href="/calendar" className="text-foreground hover:underline">
              <SourceLang fallback={eventTitle.fallback} messages={messages}>{eventTitle.text}</SourceLang>
              {" — "}{fmtUtc(event.starts_at)} ({fmtDubai(event.starts_at)})
            </Link>
          : t(messages, "status.nothingUpcoming")}
      </span>
      <span>
        {t(messages, "status.lastAlertPrefix")}{" "}
        {lastAlert
          ? <Link href="/alerts" className="text-foreground hover:underline">
              {fmtAge(lastAlert.ts, now)}
            </Link>
          : t(messages, "common.none")}
      </span>
    </div>
  );
}
