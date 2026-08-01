// Pure argv builders for the jamasp CLI subprocess calls in ./actions.
//
// jamasp is a Click application, and Click inspects every argv element for a
// leading "-"/"--" before the command body ever runs — including the final
// positional TASK argument. Left unguarded, an operator-supplied task string
// like "--dry-run" or "-0.5% move — investigate" gets parsed as an option
// token instead of data, and the command fails (or silently drops the
// argument) rather than scheduling the wakeup.
//
// The fix is the standard argv convention: a literal "--" element tells the
// parser everything after it is positional, no matter what it looks like.
// This is not a security boundary (execFile with an argv array already rules
// out shell injection) — it is purely about not letting Click reinterpret
// legitimate operator prose as flags.
export function buildWakeupAddArgs(dueAtUtc: string, runType: string, task: string): string[] {
  return ["wakeup", "add", "--", dueAtUtc, runType, task];
}

export function buildWakeupCancelArgs(id: number): string[] {
  return ["wakeup", "cancel", "--", String(id)];
}
