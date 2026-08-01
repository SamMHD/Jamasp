import { Badge } from "@/components/ui/badge";

/**
 * `ok` is a plain success; `deferred` means the daily cap was already reached
 * so the run was skipped — benign, not a failure, and deliberately excluded
 * from the cap count by `runsTodayDubai`. Only real failures (`failed`,
 * `timeout`, ...) get the destructive treatment.
 */
export function runBadge(status: string): { variant: "secondary" | "destructive" | "outline"; className?: string } {
  if (status === "ok") return { variant: "secondary" };
  if (status === "deferred") {
    return { variant: "outline", className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400" };
  }
  return { variant: "destructive" };
}

export function RunBadge({ status }: { status: string }) {
  const badge = runBadge(status);
  return <Badge variant={badge.variant} className={badge.className}>{status}</Badge>;
}
