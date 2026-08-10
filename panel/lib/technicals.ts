/**
 * Gold technical context derived from the `prices` table.
 *
 * Pure, like lib/health.ts — the page does the database reads and passes
 * quotes in. Levels come from stored series only; levels that appear in
 * stance prose (for example "4300 psychological") are deliberately excluded,
 * because regex-hunting numbers out of narrative is exactly the fragility
 * this module avoids.
 *
 * Deliberately absent: any aggregate buy/sell verdict. config/sources.yaml
 * records that TradingView's Recommend.All is not stored, because
 * "technicals annotate the macro read, they must not originate calls."
 */

export type Quote = { ts: string; value: number };
export type LevelKind = "ma" | "pivot" | "spot";
export type LevelSide = "above" | "below" | "at";
export type Level = { label: string; value: number; kind: LevelKind; side: LevelSide };

export type TechnicalsInput = {
  spot: Quote | null;
  spot24hAgo: number | null;
  sma50: Quote | null;
  sma200: Quote | null;
  pivotS1: Quote | null;
  pivotR1: Quote | null;
  rsi14: Quote | null;
  atr14: Quote | null;
  gvz: Quote | null;
  netSpec: Quote | null;
};

export type GoldTechnicals = {
  spot: { value: number; ts: string; delta24h: number | null; pct24h: number | null } | null;
  levels: Level[];
  regime: string | null;
  indicators: { rsi14: number | null; atr14: number | null;
                gvz: number | null; netSpec: number | null };
  indicatorsAsOf: string | null;
  stale: boolean;
};

/** Symbols the overview reads, in the order lib/db.ts#latestPrices wants them. */
export const TECHNICAL_SYMBOLS = [
  "GC", "GC_SMA50", "GC_SMA200", "GC_PIV_S1", "GC_PIV_R1",
  "GC_RSI14", "GC_ATR14", "^GVZ", "GC_NET_SPEC",
] as const;

/**
 * The tv_gc_technicals source polls every 360 minutes, so anything past 12h
 * means the feed has missed at least one cycle. Production shows real gaps
 * (33 indicator points across 9 days), and a gap must be visible rather than
 * rendered as if current.
 */
const STALE_MS = 12 * 3600_000;

/**
 * Paired implementation: jamasp/pricesummary.py:56-62. These four strings
 * are what the Telegram brief prints, so the panel must not paraphrase them
 * or the two surfaces will quietly disagree. Comparison is strict `>`, as
 * in the Python — spot exactly on an SMA counts as not-above.
 */
function deriveRegime(spot: number, sma50: number, sma200: number): string {
  const above50 = spot > sma50;
  const above200 = spot > sma200;
  if (above50 === above200) return above50 ? "above both" : "below both";
  return above50 ? "above 50DMA, below 200DMA" : "below 50DMA, above 200DMA";
}

function side(value: number, spot: number | null): LevelSide {
  if (spot === null || value === spot) return "at";
  return value > spot ? "above" : "below";
}

export function deriveTechnicals(input: TechnicalsInput, now: Date = new Date()): GoldTechnicals {
  const spotValue = input.spot?.value ?? null;

  const candidates: (readonly [string, Quote | null, LevelKind])[] = [
    ["200DMA", input.sma200, "ma"],
    ["pivot R1", input.pivotR1, "pivot"],
    ["spot", input.spot, "spot"],
    ["50DMA", input.sma50, "ma"],
    ["pivot S1", input.pivotS1, "pivot"],
  ];
  const levels: Level[] = candidates
    .filter((c): c is readonly [string, Quote, LevelKind] => c[1] !== null)
    .map(([label, quote, kind]) => ({
      label, value: quote.value, kind,
      side: kind === "spot" ? "at" : side(quote.value, spotValue),
    }))
    .sort((a, b) => b.value - a.value);

  // Staleness tracks the TradingView set only. GVZ (hourly Yahoo) and net
  // spec (weekly CFTC) have unrelated cadences and would mask a dead feed.
  const tvQuotes = [input.sma50, input.sma200, input.pivotS1,
                    input.pivotR1, input.rsi14, input.atr14]
    .filter((q): q is Quote => q !== null);
  const indicatorsAsOf = tvQuotes.length
    ? tvQuotes.map(q => q.ts).reduce((a, b) => (a > b ? a : b))
    : null;

  const delta24h = input.spot && input.spot24hAgo !== null
    ? input.spot.value - input.spot24hAgo
    : null;

  return {
    spot: input.spot
      ? {
          value: input.spot.value,
          ts: input.spot.ts,
          delta24h,
          pct24h: delta24h !== null && input.spot24hAgo
            ? (delta24h / input.spot24hAgo) * 100
            : null,
        }
      : null,
    levels,
    regime: spotValue !== null && input.sma50 && input.sma200
      ? deriveRegime(spotValue, input.sma50.value, input.sma200.value)
      : null,
    indicators: {
      rsi14: input.rsi14?.value ?? null,
      atr14: input.atr14?.value ?? null,
      gvz: input.gvz?.value ?? null,
      netSpec: input.netSpec?.value ?? null,
    },
    indicatorsAsOf,
    stale: indicatorsAsOf !== null
      && now.getTime() - new Date(indicatorsAsOf).getTime() > STALE_MS,
  };
}
