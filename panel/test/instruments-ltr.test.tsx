import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Time runs left-to-right on a chart in Tehran as everywhere else, and these
 * components position directionally. Letting `rtl` inherit into them mirrors
 * axes and breaks layout for no reader's benefit.
 *
 * A source assertion rather than a render assertion because several of these
 * mount TradingView or a canvas and cannot be rendered in jsdom. It is
 * deliberately literal: it catches a component that loses its pin in a
 * refactor, which is the regression that matters.
 */
// "tradingview-embed" is deliberately not here: no components/tradingview-
// embed.tsx exists in this codebase (see components/tv-widget.tsx, which is
// the actual shared TradingView mounting machinery both tradingview-mini-
// chart.tsx and ticker-tape.tsx build on). Flagged rather than fabricated —
// see the task-6 report.
const INSTRUMENTS = [
  "market-map", "map-tiles", "technical-map", "live-chart", "spot-chart",
  "price-chart", "ticker-tape", "driver-tape", "level-ladder",
  "horizon-strip", "sparkline", "arc-gauge", "weight-bar",
  "tradingview-mini-chart", "tv-widget",
];

describe("instrument components", () => {
  it.each(INSTRUMENTS)("%s pins itself LTR", name => {
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "..", "components", `${name}.tsx`), "utf8");
    expect(src).toContain('dir="ltr"');
  });
});
