/**
 * The fundamental band's forward time axis: everything scheduled that could
 * move the stance, merged onto one window. Pure, like lib/health.ts — the
 * page does the reads (events, predictions, pending wakeups) and passes
 * rows in.
 *
 * Three lanes share the axis:
 *  - calendar events, high/medium impact only (the Low tier is wire noise
 *    the desk never trades around; `jamasp calendar` applies the same cut);
 *  - open-prediction maturities, computed from created_at + horizon_days —
 *    predictions already matured but unscored are deliberately absent: the
 *    Forecast panel's "awaiting score" amber owns that state, and showing
 *    them here as well would double-count one fact on one page;
 *  - pending wakeups, with past-due ones kept and flagged `overdue` rather
 *    than silently dropped — a wakeup the dispatcher missed is exactly what
 *    the desk must see.
 *
 * Simultaneous event rows are grouped per (starts_at, country, impact):
 * a CPI release lands as four wire rows (CPI m/m, CPI y/y, core ×2) at one
 * instant, and four overlapping marks at one x would misread as a heavy
 * cluster of distinct prints.
 */

import type { EventRow, WakeupRow } from "./db";
import type { Prediction } from "./files";

export type HorizonLane = "event" | "prediction" | "wakeup";

export type HorizonEntry = {
  ts: string;
  lane: HorizonLane;
  /** Short mark/list text: "CPI m/m +3", "772323d6", "#20 deepdive". */
  label: string;
  /** Full text for the hover title and the list row. */
  detail: string;
  impact?: "high" | "medium";
  /** Stated confidence for prediction maturities; null when malformed. */
  confidence?: number | null;
  overdue?: boolean;
  href: string;
};

export type Horizon = {
  start: string;
  end: string;
  days: number;
  /** Overdue wakeups first (oldest due first), then ascending by ts. */
  entries: HorizonEntry[];
  counts: Record<HorizonLane, number>;
  overdueCount: number;
};

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function normImpact(impact: string | null): "high" | "medium" | null {
  const v = impact?.trim().toLowerCase();
  return v === "high" || v === "medium" ? v : null;
}

/** Stable representative title: shortest, alphabetical among equals. */
function groupLabel(titles: string[]): string {
  const rep = [...titles].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return titles.length > 1 ? `${rep} +${titles.length - 1}` : rep;
}

export function deriveHorizon(
  input: { events: EventRow[]; predictions: Prediction[]; wakeups: WakeupRow[] },
  now: Date = new Date(),
  days = 7,
): Horizon {
  const startMs = now.getTime();
  const endMs = startMs + days * 86400_000;
  const inWindow = (ms: number) => Number.isFinite(ms) && ms >= startMs && ms < endMs;

  const groups = new Map<string, { ts: string; impact: "high" | "medium";
    country: string | null; titles: string[] }>();
  for (const e of input.events) {
    const impact = normImpact(e.impact);
    if (!impact || !inWindow(new Date(e.starts_at).getTime())) continue;
    const key = `${e.starts_at}|${e.country ?? ""}|${impact}`;
    const g = groups.get(key);
    if (g) g.titles.push(e.title);
    else groups.set(key, { ts: e.starts_at, impact, country: e.country, titles: [e.title] });
  }
  const events: HorizonEntry[] = [...groups.values()].map(g => ({
    ts: g.ts, lane: "event", label: groupLabel(g.titles),
    detail: g.titles.join(" · ") + (g.country ? ` — ${g.country}` : ""),
    impact: g.impact, href: "/calendar",
  }));

  const predictions: HorizonEntry[] = [];
  for (const p of input.predictions) {
    if (p.outcome !== null) continue;
    const created = new Date(p.created_at).getTime();
    if (!Number.isFinite(created) || !Number.isFinite(p.horizon_days)) continue;
    const matures = created + p.horizon_days * 86400_000;
    if (!inWindow(matures)) continue;
    predictions.push({
      ts: iso(matures), lane: "prediction", label: p.id, detail: p.claim,
      confidence: typeof p.confidence === "number" && Number.isFinite(p.confidence)
        ? p.confidence : null,
      href: "/state",
    });
  }

  const wakeups: HorizonEntry[] = [];
  for (const w of input.wakeups) {
    if (w.status !== "pending") continue;
    const due = new Date(w.due_at).getTime();
    if (!Number.isFinite(due) || due >= endMs) continue;
    wakeups.push({
      ts: w.due_at, lane: "wakeup", label: `#${w.id} ${w.run_type}`, detail: w.task,
      overdue: due < startMs, href: "/schedule",
    });
  }

  const entries = [...events, ...predictions, ...wakeups].sort((a, b) => {
    if (!!a.overdue !== !!b.overdue) return a.overdue ? -1 : 1;
    return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.lane.localeCompare(b.lane);
  });

  const counts: Record<HorizonLane, number> = { event: 0, prediction: 0, wakeup: 0 };
  for (const e of entries) counts[e.lane]++;

  return {
    start: iso(startMs), end: iso(endMs), days, entries, counts,
    overdueCount: wakeups.filter(w => w.overdue).length,
  };
}
