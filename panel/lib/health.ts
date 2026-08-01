import type { AgentRunRow, SourceErrorRow } from "./db";
import type { SourceConfig } from "./files";

export type SourceHealth = { name: string; type: string; intervalMinutes: number;
  lastFetch: string | null; lastItem: string | null; errors24h: number;
  state: "ok" | "stale" | "erroring" | "never" };
export type Warning = { severity: "red" | "amber"; text: string };

const STATE_ORDER = { erroring: 0, stale: 1, never: 2, ok: 3 } as const;

export function deriveSourceHealth(
  sources: SourceConfig[],
  lastFetchBySource: Record<string, string | null>,
  lastItemBySource: Record<string, string>,
  errors: SourceErrorRow[],
  now: Date = new Date(),
): SourceHealth[] {
  const errCount = new Map<string, number>();
  for (const e of errors) errCount.set(e.source, (errCount.get(e.source) ?? 0) + 1);

  const rows = sources.map(s => {
    const lastFetch = lastFetchBySource[s.name] ?? null;
    const errors24h = errCount.get(s.name) ?? 0;
    const ageMin = lastFetch
      ? (now.getTime() - new Date(lastFetch).getTime()) / 60_000
      : Infinity;
    let state: SourceHealth["state"];
    if (errors24h >= 3 || (errors24h >= 1 && ageMin > 2 * s.interval_minutes)) {
      state = "erroring";
    } else if (!lastFetch) {
      state = "never";
    } else if (ageMin > Math.max(3 * s.interval_minutes, 60)) {
      state = "stale";
    } else {
      state = "ok";
    }
    return { name: s.name, type: s.type, intervalMinutes: s.interval_minutes,
      lastFetch, lastItem: lastItemBySource[s.name] ?? null, errors24h, state };
  });
  return rows.sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
}

export function deriveWarnings(input: {
  lastIngestAt: string | null;
  runs: AgentRunRow[];
  sourceHealth: SourceHealth[];
  runsToday: number;
  cap: number;
}, now: Date = new Date()): Warning[] {
  const out: Warning[] = [];
  const ingestAge = input.lastIngestAt
    ? (now.getTime() - new Date(input.lastIngestAt).getTime()) / 60_000
    : Infinity;
  if (ingestAge > 60) {
    out.push({ severity: "red",
      text: `ingest stale: last ran ${input.lastIngestAt ?? "never"} (> 60 min ago)` });
  }
  const cutoff = now.getTime() - 48 * 3600_000;
  for (const r of input.runs) {
    if (new Date(r.started_at).getTime() < cutoff) continue;
    if (r.status === "failed" || r.status === "timeout") {
      out.push({ severity: "red",
        text: `${r.run_type} run ${r.status} at ${r.started_at} (exit=${r.exit_code})` });
    } else if (r.status === "deferred") {
      out.push({ severity: "amber", text: `${r.run_type} run deferred at ${r.started_at}` });
    }
  }
  const bad = input.sourceHealth.filter(s => s.state === "erroring" || s.state === "stale");
  if (bad.length) {
    out.push({ severity: "amber",
      text: `sources unhealthy: ${bad.map(s => `${s.name} (${s.state})`).join(", ")}` });
  }
  if (input.runsToday >= input.cap) {
    out.push({ severity: "amber",
      text: `daily run cap reached (${input.runsToday}/${input.cap})` });
  }
  return out;
}
