import { describe, expect, it } from "vitest";
import { calibrationBins, chartBins } from "../lib/calibration";
import type { Prediction } from "../lib/files";

const pred = (confidence: number, outcome: string | null): Prediction => ({
  id: "x", date: "2026-08-01", claim: "c", direction: "up", horizon_days: 5,
  confidence, created_at: "2026-08-01T00:00:00Z",
  outcome, scored_at: outcome ? "2026-08-06T00:00:00Z" : null, note: null,
});

describe("calibrationBins", () => {
  it("buckets decisive outcomes by confidence", () => {
    const bins = calibrationBins([
      pred(0.72, "hit"), pred(0.75, "miss"), pred(0.65, "hit"),
    ]);
    expect(bins[7]).toEqual({ lo: 0.7, hi: 0.8, hits: 1, misses: 1 });
    expect(bins[6]).toEqual({ lo: 0.6, hi: 0.7, hits: 1, misses: 0 });
  });

  it("puts confidence 1.0 in the top bin rather than inventing an eleventh", () => {
    const bins = calibrationBins([pred(1.0, "hit")]);
    expect(bins).toHaveLength(10);
    expect(bins[9].hits).toBe(1);
  });

  it("excludes open, unclear and matured-unscored predictions", () => {
    const bins = calibrationBins([
      pred(0.7, null), pred(0.7, "unclear"), pred(0.7, "open"),
    ]);
    expect(bins.every(b => b.hits === 0 && b.misses === 0)).toBe(true);
  });

  it("drops out-of-range or malformed confidences instead of inventing a bar", () => {
    const bins = calibrationBins([
      pred(1.7, "hit"), pred(-0.2, "miss"), pred(NaN, "hit"),
    ]);
    expect(bins.every(b => b.hits === 0 && b.misses === 0)).toBe(true);
  });
});

describe("chartBins", () => {
  it("spans 0.5–1.0 by default", () => {
    const slice = chartBins(calibrationBins([pred(0.72, "hit")]));
    expect(slice[0].lo).toBe(0.5);
    expect(slice[slice.length - 1].hi).toBe(1);
  });

  it("extends left when a low-confidence prediction exists — it must not vanish", () => {
    const slice = chartBins(calibrationBins([pred(0.35, "miss"), pred(0.72, "hit")]));
    expect(slice[0].lo).toBe(0.3);
    expect(slice.reduce((n, b) => n + b.hits + b.misses, 0)).toBe(2);
  });

  it("keeps the 0.5–1.0 frame on an empty ledger", () => {
    const slice = chartBins(calibrationBins([]));
    expect(slice[0].lo).toBe(0.5);
    expect(slice).toHaveLength(5);
  });
});
