export const RUN_TYPES = ["brief", "scan", "deepdive", "retro"] as const;
export type RunType = (typeof RUN_TYPES)[number];

export function validateWakeup(dueAt: string, runType: string, task: string):
  { ok: true; dueAtUtc: string } | { ok: false; error: string } {
  if (!(RUN_TYPES as readonly string[]).includes(runType)) {
    return { ok: false, error: `run type must be one of ${RUN_TYPES.join(", ")}` };
  }
  if (!task.trim()) return { ok: false, error: "task text is required" };
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(dueAt)) {
    return { ok: false, error: "due time must carry a timezone (Z or offset)" };
  }
  const t = Date.parse(dueAt);
  if (isNaN(t)) return { ok: false, error: `not an ISO-8601 datetime: ${dueAt}` };
  return { ok: true, dueAtUtc: new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") };
}
