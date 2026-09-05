/**
 * The forecast ledger's derived view: what state each entry is in, when it
 * matures, and the order the desk should read it in.
 *
 * The ledger itself (state/predictions.jsonl, written by
 * jamasp/predictions.py) records only three outcomes — hit, miss, unclear —
 * and leaves `outcome: null` on everything not yet scored. A null outcome is
 * two different situations to a reader, so this module splits it the way the
 * CLI does:
 *
 *   - "open" — unscored and still running (predictions.py#open_unscored);
 *   - "due"  — unscored but matured, i.e. exactly what
 *              `jamasp predictions due` would hand the next run to score.
 *
 * Maturity is derived, not stored: created_at + horizon_days. There is no
 * due-date field in the ledger, and inventing one here would be a second
 * source of truth for a number predictions.py already computes that way.
 *
 * `files.predictionStats` counts through `predictionState`, so the overview's
 * Forecast-record card and the /predictions page cannot disagree about how
 * many predictions sit in each state — the classification lives here once.
 * That includes the awkward cases: a malformed `created_at` yields NaN, and
 * `NaN <= now` is false, so such an entry reads "open" rather than silently
 * appearing overdue, and an unrecognised `outcome` string falls through to
 * the unscored branch rather than being treated as a fourth outcome.
 */
import type { Prediction } from "./files";

export type PredictionState = "due" | "open" | "hit" | "miss" | "unclear";

/** The three states a scored prediction can be in, in ledger order. */
export const RESOLVED_STATES = ["hit", "miss", "unclear"] as const;
/** The two an unscored one can be in — "due" first: it is the actionable one. */
export const LIVE_STATES = ["due", "open"] as const;

export type LedgerRow = {
  pred: Prediction;
  state: PredictionState;
  /** Epoch ms of created_at + horizon_days; NaN when the entry is malformed. */
  maturesAt: number;
  /** True for hit/miss/unclear — the entry is settled and needs no action. */
  resolved: boolean;
};

const DAY_MS = 86400_000;

export function maturesAt(p: Prediction): number {
  return new Date(p.created_at).getTime() + p.horizon_days * DAY_MS;
}

export function predictionState(p: Prediction, now: Date = new Date()): PredictionState {
  if (p.outcome === "hit" || p.outcome === "miss" || p.outcome === "unclear") return p.outcome;
  return maturesAt(p) <= now.getTime() ? "due" : "open";
}

export function isResolved(state: PredictionState): boolean {
  return state !== "due" && state !== "open";
}

/**
 * The whole ledger as rows, in reading order.
 *
 * Live entries lead, because they are the only ones a reader can still act
 * on, and they sort ascending by maturity — one rule that happens to express
 * two intentions at once, since every due entry matured in the past and
 * every open one matures in the future: most-overdue first, then
 * soonest-to-mature. Malformed maturities (NaN) sink to the end of the live
 * group rather than sorting arbitrarily.
 *
 * Resolved entries follow, newest-scored first — a scoring log, read the way
 * every other log in this panel is. `scored_at` can be missing on an entry
 * scored by hand, so created_at is the fallback; `id` breaks the last tie so
 * the order is stable across renders rather than whatever the input happened
 * to be.
 */
export function buildLedger(preds: Prediction[], now: Date = new Date()): LedgerRow[] {
  const rows: LedgerRow[] = preds.map(pred => {
    const state = predictionState(pred, now);
    return { pred, state, maturesAt: maturesAt(pred), resolved: isResolved(state) };
  });
  const rank = (r: LedgerRow) => (r.resolved ? 1 : 0);
  const settledAt = (r: LedgerRow) =>
    new Date(r.pred.scored_at ?? r.pred.created_at).getTime();
  // Compared, never subtracted: the fallbacks below are infinities, and
  // Infinity - Infinity is NaN, which would silently collapse into "equal".
  const cmp = (x: number, y: number) => (x < y ? -1 : x > y ? 1 : 0);
  const orElse = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
  return rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.resolved) {
      // Newest settlement first; an unreadable timestamp sinks to the bottom.
      const d = cmp(orElse(settledAt(b), -Infinity), orElse(settledAt(a), -Infinity));
      if (d !== 0) return d;
    } else {
      // Earliest maturity first; an unreadable one sinks to the bottom.
      const d = cmp(orElse(a.maturesAt, Infinity), orElse(b.maturesAt, Infinity));
      if (d !== 0) return d;
    }
    return a.pred.id.localeCompare(b.pred.id);
  });
}

/** Per-state counts over the whole ledger, for the filter chips. */
export function countByState(rows: LedgerRow[]): Record<PredictionState, number> {
  const counts: Record<PredictionState, number> = {
    due: 0, open: 0, hit: 0, miss: 0, unclear: 0,
  };
  for (const r of rows) counts[r.state]++;
  return counts;
}
