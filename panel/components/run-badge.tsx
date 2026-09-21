import { Badge } from "@/components/ui/badge";
import { t, type Messages } from "@/lib/i18n";

/**
 * `run_type` is the closed set `lib/validate.ts#RUN_TYPES` defines
 * (brief/scan/deepdive/retro) — chrome, not content, so the schedule page
 * renders it through the dictionary rather than the CLI's raw slug.
 * Co-located with `runBadge`/`RunBadge` (the run-STATUS badge, a different
 * closed set) because both are "how a run's fixed attributes render" and
 * app/schedule/page.tsx is the one caller of either.
 */
export function runTypeLabel(runType: string, messages: Messages): string {
  return t(messages, `runType.${runType}`);
}

/**
 * `ok` is a plain success; `deferred` means the daily cap was already reached
 * so the run was skipped — benign, not a failure, and deliberately excluded
 * from the cap count by `runsTodayDubai`. Only real failures (`failed`,
 * `timeout`, `empty` — exited 0 having committed nothing) get the
 * destructive treatment.
 */
export function runBadge(status: string): { variant: "secondary" | "destructive" | "outline"; className?: string } {
  if (status === "ok") return { variant: "secondary" };
  if (status === "deferred") {
    return { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400" };
  }
  return { variant: "destructive" };
}

/**
 * `status` is the closed set lib/validate.ts's agent-run statuses define
 * (ok/failed/timeout/deferred/empty) — chrome, not content, same treatment
 * as `runTypeLabel` above. Falls back to the raw value for anything outside
 * that set (there shouldn't be any) rather than a dictionary-miss key.
 */
export function runStatusLabel(status: string, messages: Messages): string {
  const key = `runStatus.${status}`;
  const label = t(messages, key);
  return label !== key ? label : status;
}

export function RunBadge({ status, messages }: { status: string; messages: Messages }) {
  const badge = runBadge(status);
  return <Badge variant={badge.variant} className={badge.className}>{runStatusLabel(status, messages)}</Badge>;
}
