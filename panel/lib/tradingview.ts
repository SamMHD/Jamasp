/**
 * Every TradingView embed decision the panel makes, in one place.
 *
 * Pure — no DOM, no window — so symbol resolution, widget config and the
 * theme bridge are all unit-testable and the client components stay thin
 * mounting shells.
 *
 * THREE WIDGETS, ON PURPOSE
 * -------------------------
 * The panel embeds three different TradingView products, because they answer
 * three different questions:
 *
 *   - the **Advanced Chart** (components/live-chart.tsx) fills the technical
 *     panel's chart slot on Technical -> prices. One instrument, full
 *     candles, hourly, the reader's whole attention.
 *   - the **Mini Chart** (components/tradingview-mini-chart.tsx) fills the
 *     overview Drivers card. One card per symbol — logo, name, price, daily
 *     change, area chart — dropped into an existing 3x2 grid cell.
 *   - the **Ticker Tape** (components/ticker-tape.tsx) is the band across the
 *     top of the overview. The same driver complex again, but as a glance
 *     rather than a read: one scrolling line the desk can take in without
 *     stopping, above everything that needs thinking about.
 *
 * They are also different widget *generations*: the Advanced Chart is the
 * classic `external-embedding` script that reads a JSON config payload, while
 * the Mini Chart (`<tv-mini-chart>`) and the Ticker Tape (`<tv-ticker-tape>`)
 * are modern web components that read HTML attributes and CSS custom
 * properties. None can do another's job — the Advanced Chart cannot be tiled
 * six-up, the Mini Chart draws no candles, the tape shows no history at all
 * — so all three stay, and this module is what keeps their symbol and colour
 * decisions from drifting apart.
 *
 * WHY A LIVE WIDGET AT ALL
 * ------------------------
 * Every number this panel draws is a *stored* reading. `prices.GC` carries
 * the market bar timestamp, so on a frozen feed (or any weekend) the hero
 * figure was a day old while looking exactly like a live quote. The widgets
 * supply the live half of that comparison; Jamasp's own reading sits beside
 * them, labelled and aged, so the desk can see at a glance whether the two
 * agree — and feed staleness becomes *visible* instead of being silently
 * presented as current.
 *
 * THE ENTITLEMENT WALL BOTH WIDGETS HIT
 * -------------------------------------
 * These are keyless embeds, and TradingView gates data by plan. Symbol
 * search happily returns tickers the free widget then refuses with
 * "Permission denied — only available on TradingView": every CME-group
 * futures symbol (COMEX:GC1!, COMEX_MINI:GC1!, CME:GC1!, NYMEX:GC1!) and
 * all of TVC:*, SP:SPX, CBOE:SPX. Others resolve but cannot draw
 * ("Unsupported interval" — INDEX:DXY at every range but 6M, and the whole
 * FRED "economic" class). So every symbol below is what the free widget can
 * actually *render*, verified by mounting it, not what the desk would pick
 * given an entitlement. docs/todo/014 records what a paid plan would buy and
 * the exact symbols to repoint.
 */

/* ------------------------------------------------------------------ *
 * Symbols
 * ------------------------------------------------------------------ */

/**
 * EXCHANGE:TICKER, the only shape TradingView accepts. Anything else came
 * from an override that no longer means what this module assumes, so it
 * falls back rather than handing the widget a string that renders an
 * "invalid symbol" box.
 */
const SYMBOL_RE = /^[A-Z0-9_]{2,12}:[A-Za-z0-9._!+-]{1,20}$/;

/**
 * What Jamasp actually prices gold off: Yahoo's GC=F, the front-month
 * continuous COMEX gold future (config/sources.yaml#gold_spot,
 * jamasp/ingest/bars.py). TradingView's name for the same contract is
 * COMEX:GC1!, which is exactly what config/sources.yaml#tv_gc_technicals
 * already reads through the scanner API.
 */
export const JAMASP_INSTRUMENT = "GC=F";
export const JAMASP_TV_SYMBOL = "COMEX:GC1!";

/**
 * The instrument the embedded chart actually shows: SPOT gold, not the
 * future.
 *
 * This is a forced choice, not a preference. Verified against the live embed
 * on 2026-09-05: COMEX:GC1!, COMEX_MINI:GC1!, CME:GC1! and NYMEX:GC1! all
 * render an empty chart in the keyless widget — CME Group data needs a paid
 * TradingView data plan, and the free embed has no entitlement for it, so
 * the frame comes back either blank or "This symbol doesn't exist". Every
 * XAU/USD feed renders fine. A blank box is worse than a spot chart, so the
 * widget carries spot and the panel SAYS it carries spot.
 *
 * FX_IDC is ICE's aggregate rather than a single broker's book — the closest
 * thing here to a benchmark, and it prints as "Gold Spot / U.S. Dollar"
 * rather than a broker's own CFD name.
 *
 * The consequence the panel must state out loud: front-month futures trade
 * ABOVE spot by the carry (financing plus storage — tens of dollars at
 * current levels). So a standing gap between the widget and Jamasp's reading
 * is the basis, not staleness, and the reading box says so. Anyone reading
 * that gap as drift would be reading it wrong.
 */
export const TV_LIVE_SYMBOL = "FX_IDC:XAUUSD";

/** How the panel names the widget's instrument in prose. */
export const TV_LIVE_LABEL = "spot XAU/USD";

/**
 * The symbol the widget should chart, with an operator override.
 *
 * The override exists because the default above is imposed by a *data
 * entitlement*, not by what the desk wants to see: a TradingView account
 * carrying CME data would render COMEX:GC1! — the exact contract Jamasp
 * prices off — and make the comparison apples-to-apples. That should be a
 * config edit, not a code change, so:
 *
 *   panel:
 *     tradingview_symbol: "COMEX:GC1!"
 *
 * in config/settings.yaml repoints it. Anything unparseable falls back to
 * the working default: a mistyped override must not blank the chart.
 */
export function liveGoldSymbol(settings: Record<string, unknown>): string {
  const panel = settings.panel as { tradingview_symbol?: unknown } | undefined;
  const raw = panel?.tradingview_symbol;
  if (typeof raw !== "string") return TV_LIVE_SYMBOL;
  const trimmed = raw.trim();
  return SYMBOL_RE.test(trimmed) ? trimmed : TV_LIVE_SYMBOL;
}

export type TvEmbed = {
  /** Exchange-prefixed TradingView symbol. */
  symbol: string;
  /**
   * Chart range. "1D" is intraday and is what the Drivers card wants; a
   * symbol that refuses it renders "Unsupported interval" rather than a
   * chart, so the value here is per-symbol and verified, never assumed.
   */
  timeFrame: string;
};

/**
 * Jamasp driver symbol -> TradingView embed, for the overview Drivers card.
 *
 * Driver symbols only: components/driver-panel.tsx looks every cell up here,
 * and a key that is not in lib/drivers.ts#DRIVER_SPECS would be a mapping
 * nothing renders. Gold's chart symbol is NOT in this table for that reason
 * — it is TV_LIVE_SYMBOL above, consumed by a different widget.
 *
 * Every entry was verified by mounting the widget and reading the rendered
 * price, not by trusting symbol search (see "the entitlement wall" at the
 * top of this file). Where several venues carried an instrument, the one
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
 * The tape's line-up, derived from the Drivers card rather than listed again.
 *
 * Membership AND order both come from the caller's driver symbols
 * (lib/drivers.ts#DRIVER_SPECS), so the band across the top of the overview
 * and the grid further down are the same complex read the same way round —
 * a second hand-kept list would be one retune away from disagreeing with
 * the card it is supposed to summarise.
 *
 * The real-yield driver drops out here for free: it is the one driver
 * DRIVER_TV_EMBEDS deliberately maps to null (see the note there), and the
 * same null that keeps a nominal yield out of the Drivers grid keeps one out
 * of the tape. Nothing about the exception is restated; it just holds.
 */
export function tickerTapeSymbols(jamaspSymbols: readonly string[]): string[] {
  return jamaspSymbols
    .map(tvEmbedFor)
    .filter((e): e is TvEmbed => e !== null)
    .map(e => e.symbol);
}

/**
 * The Ticker Tape web component's attributes.
 *
 * `symbols` is comma-separated because that is the converter the widget
 * actually installs for array-typed properties — a JSON array here parses as
 * one long nonsense ticker rather than failing loudly.
 *
 * `item-size="compact"` is the 48px row: a band, not a second Drivers card.
 * It keeps the tape's claim on above-the-fold space to about a line of text,
 * which is the most a glance-only strip has earned.
 *
 * `transparent` for the same reason the Mini Chart carries it — the panel's
 * own surface shows through, so the tape reads as part of the page rather
 * than as a rectangle someone else painted.
 *
 * `theme` is deliberately NOT here: it is the one attribute that changes
 * after mount (the appearance toggle), so the mounting component owns it.
 */
export function tickerTapeAttributes(symbols: readonly string[]): Record<string, string> {
  return {
    symbols: symbols.join(","),
    direction: "horizontal",
    "item-size": "compact",
    transparent: "",
  };
}

/* ------------------------------------------------------------------ *
 * Loaders
 * ------------------------------------------------------------------ */

/** TradingView's own loader for the Advanced Chart embed. */
export const TV_SCRIPT_SRC =
  "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

/**
 * The ES-module loader for the Mini Chart web component. One script serves
 * every instance on the page; browsers deduplicate identical script requests,
 * and the widgets share their chunks (TradingView's "Multiple widgets on one
 * page" guidance).
 */
export const TV_MINI_CHART_SCRIPT =
  "https://widgets.tradingview-widget.com/w/en/tv-mini-chart.js";

export const TV_MINI_CHART_TAG = "tv-mini-chart";

/**
 * The Ticker Tape's loader, same generation and same host as the Mini
 * Chart's — the two share their chunks, so the tape's script is the only
 * additional bytes the overview pays for it.
 */
export const TV_TICKER_TAPE_SCRIPT =
  "https://widgets.tradingview-widget.com/w/en/tv-ticker-tape.js";

export const TV_TICKER_TAPE_TAG = "tv-ticker-tape";

/**
 * The tape's rendered height, in pixels, at `item-size="compact"`.
 *
 * Not a guess and not a preference: the widget sizes its own row from a
 * fixed table keyed on direction and item size (horizontal+compact = 48px,
 * horizontal+normal = 74px) and then fills its container. The panel has to
 * know that number because the band sits ABOVE THE FOLD — the one place on
 * this page where a box that grows when the embed arrives would shove the
 * whole overview down under the reader. So the strip reserves exactly this
 * height from the server render onward and the widget lands inside it,
 * shifting nothing.
 */
export const TV_TICKER_TAPE_HEIGHT = 48;

/* ------------------------------------------------------------------ *
 * Theming
 * ------------------------------------------------------------------ */

/**
 * The panel palette token behind each TradingView colour role — the single
 * place either widget names a colour.
 *
 * The two widget generations consume it differently and there is no avoiding
 * that: the Mini Chart web component reads CSS custom properties at paint
 * time (so it takes `var(--token)` strings, below), while the Advanced Chart
 * bakes hex values into its JSON config at construction (so its client
 * resolves these same token names off the live root — see
 * components/live-chart.tsx#readAppearance). Naming the tokens once here is
 * what stops the two embeds from drifting apart when the palette is retuned,
 * which is exactly what happened when each widget carried its own list.
 */
export const TV_PALETTE_ROLES = {
  background: "--background",
  grid: "--border",
  text: "--foreground",
  accent: "--primary",
  scales: "--ink-dim",
  positive: "--up",
  negative: "--down",
  font: "--font-sans",
} as const;

/**
 * CSS custom properties TradingView reads for its own theming, mapped onto
 * the panel's palette tokens so an embed inherits the card's colours instead
 * of arriving in TradingView's default blue-on-white.
 *
 * `--tv-widget-background-color: transparent` is the one role that is NOT
 * TV_PALETTE_ROLES.background: it lets the tile's own background show
 * through, which is what makes the widget cells and the Jamasp-sourced
 * DFII10 cell read as one family. The Advanced Chart cannot do the same —
 * it paints its own full-bleed canvas and needs a real colour — so it uses
 * the token itself. The token names are TradingView's public contract
 * (their "Set styles and themes" guide); the values are ours.
 */
export const TV_THEME_TOKENS: Readonly<Record<string, string>> = {
  "--tv-widget-background-color": "transparent",
  "--tv-widget-text-color": `var(${TV_PALETTE_ROLES.text})`,
  "--tv-widget-price-text-color": `var(${TV_PALETTE_ROLES.text})`,
  "--tv-widget-accent-color": `var(${TV_PALETTE_ROLES.accent})`,
  "--tv-widget-scales-font-color": `var(${TV_PALETTE_ROLES.scales})`,
  "--tv-widget-positive-color": `var(${TV_PALETTE_ROLES.positive})`,
  "--tv-widget-negative-color": `var(${TV_PALETTE_ROLES.negative})`,
  "--tv-widget-font-family": `var(${TV_PALETTE_ROLES.font})`,
};

export type ChartAppearance = {
  theme: "light" | "dark";
  /** Resolved values of TV_PALETTE_ROLES.background / .grid off the live root. */
  backgroundColor: string;
  gridColor: string;
};

/**
 * The Advanced Chart embed's config payload.
 *
 * `interval: "60"` matches the hourly GC bars Jamasp stores
 * (jamasp/ingest/bars.py), so the widget's candles and the stored series are
 * the same resolution — a 1-minute chart beside an hourly reading would make
 * every ordinary tick look like drift.
 *
 * `timezone: "Etc/UTC"` because every other timestamp on this panel is
 * UTC-stamped (lib/format.ts#fmtUtc). Dubai local time here would put the
 * widget's axis an hour-count away from the ages printed beside it.
 *
 * The controls that could change what is being shown are off — symbol
 * change, saved images, the drawing rail. A wall-screen instrument that a
 * passer-by can silently retune to silver is worse than no instrument, and
 * the whole comparison depends on the symbol staying the one the caption
 * names.
 *
 * Deliberately absent, as everywhere else on this panel: any of
 * TradingView's aggregate buy/sell gauges. config/sources.yaml records why —
 * technicals annotate the macro read, they must not originate calls.
 */
export function advancedChartConfig(symbol: string, look: ChartAppearance) {
  return {
    autosize: true,
    symbol,
    interval: "60",
    timezone: "Etc/UTC",
    theme: look.theme,
    style: "1",
    locale: "en",
    backgroundColor: look.backgroundColor,
    gridColor: look.gridColor,
    hide_top_toolbar: false,
    hide_side_toolbar: true,
    hide_legend: false,
    allow_symbol_change: false,
    save_image: false,
    withdateranges: false,
    details: false,
    calendar: false,
    support_host: "https://www.tradingview.com",
  };
}
