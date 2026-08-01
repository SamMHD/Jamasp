import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { RunBadge } from "@/components/run-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AddWakeupDialog, CancelButton, RunNowButtons } from "@/components/schedule-forms";
import * as db from "@/lib/db";
import { maxRunsPerDay } from "@/lib/files";
import { fmtAge, fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

function runDuration(started: string, finished: string | null): string {
  if (!finished) return "—";
  return `${Math.round((new Date(finished).getTime() - new Date(started).getTime()) / 1000)}s`;
}

export default function SchedulePage() {
  const now = new Date();
  const pending = db.getWakeups("pending");
  const history = db.getWakeups().filter(w => w.status !== "pending").slice(0, 20);
  const runs = db.getAgentRuns(30);
  const runsToday = db.runsTodayDubai(now);
  const cap = maxRunsPerDay();

  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Schedule" />
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <StatCard label="Runs today (Dubai)" value={`${runsToday}/${cap}`}
          tone={runsToday >= cap ? "warn" : undefined} />
        <div className="space-y-2">
          <RunNowButtons capped={runsToday >= cap} />
          <AddWakeupDialog />
        </div>
      </div>
      <h2 className="mb-2 font-medium">Pending wakeups</h2>
      <Table>
        <TableHeader><TableRow>
          <TableHead>#</TableHead><TableHead>Due (UTC)</TableHead><TableHead>In</TableHead>
          <TableHead>Type</TableHead><TableHead>Task</TableHead><TableHead /></TableRow>
        </TableHeader>
        <TableBody>
          {pending.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">none</TableCell></TableRow>}
          {pending.map(w => (
            <TableRow key={w.id}>
              <TableCell>{w.id}</TableCell><TableCell>{fmtUtc(w.due_at)}</TableCell>
              <TableCell>{fmtAge(w.due_at, now)}</TableCell><TableCell>{w.run_type}</TableCell>
              <TableCell className="max-w-md truncate">{w.task}</TableCell>
              <TableCell><CancelButton id={w.id} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <h2 className="mb-2 mt-8 font-medium">Agent runs</h2>
      <Table>
        <TableHeader><TableRow>
          <TableHead>Started</TableHead><TableHead>Type</TableHead><TableHead>Status</TableHead>
          <TableHead>Duration</TableHead><TableHead>Exit</TableHead><TableHead>Task</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {runs.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">none</TableCell></TableRow>}
          {runs.map(r => (
            <TableRow key={r.id}>
              <TableCell>{fmtUtc(r.started_at)}</TableCell><TableCell>{r.run_type}</TableCell>
              <TableCell><RunBadge status={r.status} /></TableCell>
              <TableCell>{runDuration(r.started_at, r.finished_at)}</TableCell>
              <TableCell>{r.exit_code ?? "—"}</TableCell>
              <TableCell className="max-w-md truncate">{r.task ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <h2 className="mb-2 mt-8 font-medium">Wakeup history</h2>
      <ul className="space-y-1 text-sm text-muted-foreground">
        {history.length === 0 && <li>none</li>}
        {history.map(w => (
          <li key={w.id}>#{w.id} {w.run_type} · {w.status} · due {fmtUtc(w.due_at)} · {w.task}</li>
        ))}
      </ul>
    </div>
  );
}
