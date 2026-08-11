/**
 * Calibration view of the prediction ledger: scored, decisive outcomes
 * bucketed by stated confidence, for the forecast-record chart.
 *
 * Pure. Open and matured-unscored predictions are counted elsewhere
 * (files.predictionStats); "unclear" outcomes are excluded here because a
 * prediction that could not be scored carries no calibration information —
 * folding it into either arm would misstate the record.
 */
import type { Prediction } from "./files";

export type CalibrationBin = { lo: number; hi: number; hits: number; misses: number };

/**
 * Ten fixed bins over [0, 1]. A confidence of exactly 1.0 lands in the top
 * bin rather than an eleventh; out-of-range or non-numeric confidences are
 * dropped (a malformed ledger line must not invent a bar).
 */
export function calibrationBins(preds: Prediction[]): CalibrationBin[] {
  const bins: CalibrationBin[] = Array.from({ length: 10 }, (_, i) => ({
    lo: i / 10, hi: (i + 1) / 10, hits: 0, misses: 0,
  }));
  for (const p of preds) {
    if (p.outcome !== "hit" && p.outcome !== "miss") continue;
    const c = p.confidence;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) continue;
    const i = Math.min(9, Math.floor(c * 10));
    if (p.outcome === "hit") bins[i].hits++;
    else bins[i].misses++;
  }
  return bins;
}

/**
 * The contiguous slice the chart should span: from the first populated bin
 * (but never starting later than 0.5 — a forecast ledger whose confidences
 * all sit at 0.7 still reads against the 50–100% frame) through 1.0. On an
 * empty ledger this is the 0.5–1.0 frame; the component states emptiness
 * instead of drawing it.
 */
export function chartBins(bins: CalibrationBin[]): CalibrationBin[] {
  const first = bins.findIndex(b => b.hits + b.misses > 0);
  const start = first === -1 ? 5 : Math.min(first, 5);
  return bins.slice(start);
}
