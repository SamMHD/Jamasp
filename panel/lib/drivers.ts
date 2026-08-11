/**
 * Cross-asset driver reads for the overview instrument panel.
 *
 * Pure, like lib/health.ts and lib/technicals.ts — the page does the
 * database reads (latest quote, honest 24h reference via
 * db.priceDeltaReference, a short series for the sparkline) and this module
 * assembles them. The 24h delta inherits priceDeltaReference's refusal to
 * compare a frozen series against itself: a null reference stays null here
 * and renders as "24h —", never as a confident zero.
 *
 * Deltas are absolute, not percentages, by design: rates (DFII10, ^TNX)
 * move in points where a percent-of-value is meaningless, and no driver may
 * ever render the "0.00%" string the overview E2E forbids.
 */
import type { PricePoint } from "./db";
import type { Quote } from "./technicals";

export type DriverSpec = { symbol: string; label: string; digits: number };

/**
 * Display order: the drivers most causally linked to gold first (dollar,
 * real yield, nominal yield), then the broader risk complex. Shanghai and
 * LBMA prints are deliberately absent: SGE_AU_CNY_G is CNY/gram and turning
 * it into a comparable premium needs a USDCNY cross this database does not
 * store — a fabricated conversion would be worse than no tile.
 */
export const DRIVER_SPECS: readonly DriverSpec[] = [
  { symbol: "DX-Y.NYB", label: "DXY", digits: 2 },
  { symbol: "DFII10", label: "US 10y real", digits: 2 },
  { symbol: "^TNX", label: "US 10y", digits: 2 },
  { symbol: "USDJPY", label: "USD/JPY", digits: 2 },
  { symbol: "^GSPC", label: "S&P 500", digits: 0 },
  { symbol: "BTC-USD", label: "BTC", digits: 0 },
] as const;

export type DriverRead = {
  symbol: string;
  label: string;
  digits: number;
  quote: Quote | null;
  /** null = no honest reference exists (frozen feed, or no quote at all). */
  delta24h: number | null;
  series: PricePoint[];
};

export function deriveDriver(
  spec: DriverSpec,
  quote: Quote | null,
  ref24h: number | null,
  series: PricePoint[],
): DriverRead {
  return {
    symbol: spec.symbol,
    label: spec.label,
    digits: spec.digits,
    quote,
    delta24h: quote !== null && ref24h !== null ? quote.value - ref24h : null,
    series,
  };
}

/**
 * Change from the previous *distinct* print in a sparse series (the weekly
 * CFTC net-spec line). Null when fewer than two distinct observations
 * exist — one print is a value, not a change, and rendering it as "+0"
 * would be the same fabrication the 24h delta guard exists to prevent.
 */
export function printDelta(
  series: PricePoint[],
): { delta: number; prevTs: string } | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  for (let i = series.length - 2; i >= 0; i--) {
    if (series[i].ts !== last.ts) {
      return { delta: last.value - series[i].value, prevTs: series[i].ts };
    }
  }
  return null;
}
