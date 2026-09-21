import { cookies } from "next/headers";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { RunBadge, runTypeLabel } from "@/components/run-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AddWakeupDialog, CancelButton, RunNowButtons } from "@/components/schedule-forms";
import * as db from "@/lib/db";
import { maxRunsPerDay } from "@/lib/files";
import { fmtAge, fmtUtc } from "@/lib/format";
import { getMessages, LANG_COOKIE, resolveLocale, t, type Messages } from "@/lib/i18n";

export const dynamic = "force-dynamic";

function runDuration(started: string, finished: string | null): string {
  if (!finished) return "—";
  return `${Math.round((new Date(finished).getTime() - new Date(started).getTime()) / 1000)}s`;
}

/** `status` is the wakeups table's closed set (jamasp/wakeup.py, dispatch.py):
 *  pending, cancelled, done, failed. Same fallback discipline as RunBadge's
 *  runStatusLabel — a value outside the set renders as-is, never a raw key. */
function wakeupStatusLabel(status: string, messages: Messages): string {
  const key = `wakeupStatus.${status}`;
  const label = t(messages, key);
  return label !== key ? label : status;
}

export default async function SchedulePage() {
  // Same pattern as app/page.tsx and app/calendar/page.tsx: the locale
  // cookie is httpOnly, so only a server component may read it.
  const locale = resolveLocale((await cookies()).get(LANG_COOKIE)?.value);
  const messages = getMessages(locale);

  const now = new Date();
  const pending = db.getWakeups("pending");
  const history = db.getWakeups().filter(w => w.status !== "pending").slice(0, 20);
  const runs = db.getAgentRuns(30);
  const runsToday = db.runsTodayDubai(now);
  const cap = maxRunsPerDay();

  return (
    <div>
      <AutoRefresh />
      <PageHeader title={t(messages, "nav.schedule")} />
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <StatCard label={t(messages, "schedule.runsTodayLabel")} value={`${runsToday}/${cap}`}
          tone={runsToday >= cap ? "warn" : undefined} />
        <div className="space-y-2">
          <RunNowButtons capped={runsToday >= cap} messages={messages} />
          <AddWakeupDialog messages={messages} />
        </div>
      </div>
      <h2 className="mb-2 font-medium">{t(messages, "schedule.pendingWakeups")}</h2>
      <Table>
        <TableHeader><TableRow>
          <TableHead>#</TableHead><TableHead>{t(messages, "table.due")}</TableHead>
          <TableHead>{t(messages, "table.in")}</TableHead>
          <TableHead>{t(messages, "table.type")}</TableHead>
          <TableHead>{t(messages, "table.task")}</TableHead><TableHead /></TableRow>
        </TableHeader>
        <TableBody>
          {pending.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">{t(messages, "schedule.none")}</TableCell></TableRow>}
          {pending.map(w => (
            <TableRow key={w.id}>
              <TableCell>{w.id}</TableCell><TableCell>{fmtUtc(w.due_at)}</TableCell>
              <TableCell>{fmtAge(w.due_at, now)}</TableCell><TableCell>{runTypeLabel(w.run_type, messages)}</TableCell>
              <TableCell className="max-w-md truncate">{w.task}</TableCell>
              <TableCell><CancelButton id={w.id} messages={messages} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <h2 className="mb-2 mt-8 font-medium">{t(messages, "schedule.agentRuns")}</h2>
      <Table>
        <TableHeader><TableRow>
          <TableHead>{t(messages, "table.started")}</TableHead><TableHead>{t(messages, "table.type")}</TableHead>
          <TableHead>{t(messages, "table.status")}</TableHead>
          <TableHead>{t(messages, "table.duration")}</TableHead><TableHead>{t(messages, "table.exit")}</TableHead>
          <TableHead>{t(messages, "table.task")}</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {runs.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">{t(messages, "schedule.none")}</TableCell></TableRow>}
          {runs.map(r => (
            <TableRow key={r.id}>
              <TableCell>{fmtUtc(r.started_at)}</TableCell><TableCell>{runTypeLabel(r.run_type, messages)}</TableCell>
              <TableCell><RunBadge status={r.status} messages={messages} /></TableCell>
              <TableCell>{runDuration(r.started_at, r.finished_at)}</TableCell>
              <TableCell>{r.exit_code ?? "—"}</TableCell>
              <TableCell className="max-w-md truncate">{r.task ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <h2 className="mb-2 mt-8 font-medium">{t(messages, "schedule.wakeupHistory")}</h2>
      <ul className="space-y-1 text-sm text-muted-foreground">
        {history.length === 0 && <li>{t(messages, "schedule.none")}</li>}
        {history.map(w => (
          <li key={w.id}>#{w.id} {runTypeLabel(w.run_type, messages)} · {wakeupStatusLabel(w.status, messages)} ·{" "}
            {t(messages, "schedule.dueWord")} {fmtUtc(w.due_at)} · {w.task}</li>
        ))}
      </ul>
    </div>
  );
}
