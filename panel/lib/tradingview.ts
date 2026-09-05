/**
 * TradingView embed configuration for the overview Drivers card.
 *
 * Pure and DOM-free, like lib/drivers.ts, so the symbol mapping is unit
 * testable without a browser. The component that actually mounts a widget is
 * components/tradingview-mini-chart.tsx.
 *
 * WHY THE MINI CHART AND NOT THE "TICKERS" WIDGET
 * -----------------------------------------------
 * TradingView's Tickers widget (`tv-tickers`) is a single element holding a
 * strip of symbols: horizontal, min 200px per item, with a scroll chevron
 * when they don't fit. It does draw a per-symbol sparkline, but it cannot be
 * broken across a 3x2 grid and it cannot have one of its cells sourced from
 * somewhere else — which this card requires, because one driver has no
 * TradingView equivalent at all (see DFII10 below). The Mini Chart widget
 * (`tv-mini-chart`) is one card per symbol — logo, name, price, daily change
 * and an area chart — so it drops into an existing grid cell and leaves the
 * neighbouring cell free to stay a Jamasp tile.
 *
 * WHAT THE WIDGET COSTS US
 * ------------------------
 * The widget states change as a PERCENT. lib/drivers.ts explains why this
 * card's own deltas are absolute — a percent-of-value is meaningless on a
 * yield — and the widget gives us no say in it. That is why the Jamasp
 * reading stays on screen underneath every widget as an attributed footer
 * ("jamasp <value> · <age>"): the desk keeps the absolute 24h move and the
 * provenance age line the card was built around, and gains a live price
 * above it. It also makes feed staleness *visible* (a live widget over a
 * 25h-old Jamasp reading) instead of silently presenting stale data as
 * current, which was the complaint that prompted this.
 */

/**
 * The ES-module loader for the Mini Chart web component. One script serves
 * every instance on the page; browsers deduplicate identical script requests,
 * and the widgets share their chunks (TradingView's "Multiple widgets on one
 * page" guidance).
 */
export const TV_MINI_CHART_SCRIPT =
  "https://widgets.tradingview-widget.com/w/en/tv-mini-chart.js";

export const TV_MINI_CHART_TAG = "tv-mini-chart";

export type TvEmbed = {
  /** Exchange-prefixed TradingView symbol. */
  symbol: string;
  /**
   * Chart range. "1D" is intraday and is what this card wants; a symbol that
   * refuses it renders "Unsupported interval" rather than a chart, so the
   * value here is per-symbol and verified, never assumed.
   */
  timeFrame: string;
};

/**
 * Jamasp driver symbol -> TradingView embed.
 *
 * Every entry was verified by mounting the widget and reading the rendered
 * price, not by trusting symbol search: TradingView's search happily returns
 * tickers the free widget then refuses with "Permission denied" (all of
 * TVC:*, SP:SPX, CBOE:SPX and COMEX:GC1! do exactly that), and returns
 * others that resolve but cannot draw ("Unsupported interval", INDEX:DXY at
 * every range but 6M). Where several venues carried an instrument, the one
 * whose printed level matched Jamasp's own series was chosen, so the widget
 * and the brief quote the same number:
 *
 *   PEPPERSTONE:USDX  99.169   vs  Jamasp DX-Y.NYB  99.16
 *   PYTH:US10Y        4.78317  vs  Jamasp ^TNX      4.78
 *   FX:USDJPY         156.195  vs  Jamasp JPY=X     156.22
 *
 * Two entries are proxies rather than the index itself, and the difference is
 * real rather than rounding — the desk should know which tile is which:
 *
 *   SPREADEX:SPX      7,708.65 vs  Jamasp ^GSPC     7,718    (-0.13%, CFD)
 *   BITSTAMP:BTCUSD   79,787   vs  Jamasp BTC-USD   80,035   (-0.31%, one
 *                                  venue vs Yahoo's cross-venue aggregate)
 *
 * DFII10 IS DELIBERATELY ABSENT. The 10-year real yield is a TIPS constant
 * maturity series; TradingView carries it only as FRED:DFII10, type
 * "economic", and the free widget cannot render that class of symbol — it
 * answers "Unsupported interval" at 1D/1M and "Something went wrong" at 6M,
 * 1Y and 5Y. No quotable equivalent exists: a search for the instrument
 * returns FRED:DFII5/7/20/30 (same dead class) and otherwise only NOMINAL
 * yields (TVC:US10Y, PYTH:US10Y, OANDA:USB10YUSD). Substituting a nominal
 * yield for a real one would quietly corrupt the analysis this desk runs on
 * — real yields are a primary gold driver and the two are not
 * interchangeable — so this driver keeps its Jamasp-sourced tile, and the
 * card is mixed on purpose.
 */
export const DRIVER_TV_EMBEDS: Readonly<Record<string, TvEmbed>> = {
  "DX-Y.NYB": { symbol: "PEPPERSTONE:USDX", timeFrame: "1D" },
  "^TNX": { symbol: "PYTH:US10Y", timeFrame: "1D" },
  USDJPY: { symbol: "FX:USDJPY", timeFrame: "1D" },
  "^GSPC": { symbol: "SPREADEX:SPX", timeFrame: "1D" },
  "BTC-USD": { symbol: "BITSTAMP:BTCUSD", timeFrame: "1D" },
};

/** The embed for a Jamasp driver symbol, or null when none exists. */
export function tvEmbedFor(jamaspSymbol: string): TvEmbed | null {
  return DRIVER_TV_EMBEDS[jamaspSymbol] ?? null;
}

/**
 * CSS custom properties TradingView reads for its own theming, mapped onto
 * the panel's palette tokens so an embed inherits the card's colours instead
 * of arriving in TradingView's default blue-on-white.
 *
 * `--tv-widget-background-color: transparent` lets the tile's own background
 * show through, which is what makes the widget cells and the Jamasp-sourced
 * DFII10 cell read as one family. The token names are TradingView's public
 * contract (their "Set styles and themes" guide); the values are ours.
 */
export const TV_THEME_TOKENS: Readonly<Record<string, string>> = {
  "--tv-widget-background-color": "transparent",
  "--tv-widget-text-color": "var(--foreground)",
  "--tv-widget-price-text-color": "var(--foreground)",
  "--tv-widget-accent-color": "var(--primary)",
  "--tv-widget-scales-font-color": "var(--ink-dim)",
  "--tv-widget-positive-color": "var(--up)",
  "--tv-widget-negative-color": "var(--down)",
  "--tv-widget-font-family": "var(--font-sans)",
};
