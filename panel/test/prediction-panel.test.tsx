import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PredictionPanel } from "../components/prediction-panel";
import { calibrationBins } from "../lib/calibration";
import type { PredictionStats } from "../lib/files";
import type { Prediction } from "../lib/files";

const pred = (confidence: number, outcome: string | null): Prediction => ({
  id: "x", date: "2026-08-01", claim: "c", direction: "up", horizon_days: 5,
  confidence, created_at: "2026-08-01T00:00:00Z",
  outcome, scored_at: outcome ? "2026-08-06T00:00:00Z" : null, note: null,
});

const stats = (over: Partial<PredictionStats>): PredictionStats => ({
  open: 0, maturedUnscored: 0, scored: 0, hits: 0, misses: 0, unclear: 0,
  hitRate: null, ...over,
});

describe("PredictionPanel", () => {
  it("renders hit rate, counts and the calibration chart", () => {
    const preds = [pred(0.72, "hit"), pred(0.72, "hit"), pred(0.85, "miss")];
    const html = renderToStaticMarkup(
      <PredictionPanel bins={calibrationBins(preds)}
        stats={stats({ scored: 3, hits: 2, misses: 1, hitRate: 2 / 3 })} />);
    expect(html).toContain("67%");
    expect(html).toContain("2 hit · 1 miss · 0 unclear · 0 open");
    expect(html).toContain("<svg");
    expect(html).toContain("hit (above line)");
    expect(html).toContain("miss (below line)");
    expect(html).toContain("view as table");
  });

  it("keeps every count reachable without hover via the table twin", () => {
    const preds = [pred(0.72, "hit"), pred(0.72, "hit"), pred(0.85, "miss")];
    const html = renderToStaticMarkup(
      <PredictionPanel bins={calibrationBins(preds)}
        stats={stats({ scored: 3, hits: 2, misses: 1, hitRate: 2 / 3 })} />);
    expect(html).toContain("70–80%");
    expect(html).toContain("80–90%");
  });

  it("states an empty ledger outright", () => {
    const html = renderToStaticMarkup(
      <PredictionPanel bins={calibrationBins([])} stats={stats({})} />);
    expect(html).toContain("no predictions recorded");
    expect(html).not.toContain("<svg");
  });

  it("says 'none scored yet' when the ledger has only open predictions — no empty chart", () => {
    const html = renderToStaticMarkup(
      <PredictionPanel bins={calibrationBins([pred(0.7, null)])}
        stats={stats({ open: 1 })} />);
    expect(html).toContain("none scored yet");
    expect(html).toContain("1 open");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("%</");   // no fabricated hit-rate figure
  });

  it("draws no chart from unclear-only outcomes — they carry no calibration information", () => {
    const html = renderToStaticMarkup(
      <PredictionPanel bins={calibrationBins([pred(0.7, "unclear")])}
        stats={stats({ scored: 1, unclear: 1 })} />);
    expect(html).toContain("none scored yet");
    expect(html).toContain("1 unclear");
    expect(html).not.toContain("<svg");
  });

  it("flags matured-but-unscored predictions in amber", () => {
    const html = renderToStaticMarkup(
      <PredictionPanel bins={calibrationBins([])}
        stats={stats({ open: 1, maturedUnscored: 2 })} />);
    expect(html).toContain("2 awaiting score");
    expect(html).toContain("text-amber-600");
  });
});
