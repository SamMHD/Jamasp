/**
 * Every TradingView embed decision the panel makes, in one place.
 *
 * Pure — no DOM, no window — so symbol resolution, widget config and the
 * theme bridge are all unit-testable and the client components stay thin
 * mounting shells.
 *
 * SEVERAL WIDGETS, ON PURPOSE
 * ---------------------------
 * The panel embeds several different TradingView products, because they
 * answer different questions. Three are woven INTO Jamasp's own analysis:
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
 * The rest are the **reference desk** (app/markets/page.tsx, plus the
 * economic calendar under Jamasp's own on app/calendar/page.tsx). Those are
 * third-party reference data and are labelled as such everywhere they appear
 * — see "The reference desk" at the foot of this file, which also records
 * which requested widgets were refused and why.
 *
 * They are also different widget *generations*, and that line does NOT
 * follow the ours/reference one: the Advanced Chart and most of the
 * reference desk are the classic `external-embedding` scripts that read a
 * JSON config payload, while the Mini Chart (`<tv-mini-chart>`), the Ticker
 * Tape (`<tv-ticker-tape>`) and the seasonal chart (`<tv-seasonal-chart>`)
 * are modern web components that read HTML attributes and CSS custom
 * properties. Neither generation can do the other's job — the Advanced Chart
 * cannot be tiled six-up, the Mini Chart draws no candles, the tape shows no
 * history at all, and the watchlist, market summary, heatmap, screener, news
 * and calendar exist ONLY as classic embeds — so both stay, and this module
 * is what keeps their symbol and colour
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
 * futures symbol (COMEX:GC1!, COMEX_MINI:GC1!, CME:GC1!, NYMEX:GC1!), plus
 * SP:SPX, CBOE:SPX, CBOE:GVZ and the ECONOMICS:* class. Others resolve but
 * cannot draw ("Unsupported interval" — INDEX:DXY at every range but 6M, and
 * the whole FRED "economic" class). So every symbol below is what the free
 * widget can actually *render*, verified by mounting it, not what the desk
 * would pick given an entitlement. docs/todo/014 records what a paid plan
 * would buy and the exact symbols to repoint.
 *
 * Entitlement is PER SYMBOL, not per namespace, and it is easy to
 * over-generalise from a couple of refusals. docs/todo/014 recorded "all of
 * TVC:*" as denied; re-probed on 2026-09-06 while building the reference
 * desk, TVC:GOLD and TVC:UKOIL both render live prices while TVC:DXY and
 * TVC:VIX stay denied. So a prefix is never evidence either way — mount the
 * symbol and look at it.
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

/**
 * The classic embed loader for any *other* TradingView widget, by its
 * documented widget name.
 *
 * The Advanced Chart's own constant above stays spelled out rather than
 * being expressed through this helper: it is the one embed whose exact URL
 * a test pins, and a helper call there would make that assertion a
 * restatement of this function rather than a check on it.
 *
 * Every widget the /markets page mounts is this generation. That is not a
 * preference — the modern web-component generation
 * (widgets.tradingview-widget.com) publishes only a handful of small tiles,
 * of which the panel already uses the one it needs (Mini Chart). The
 * watchlist, market summary, heatmap, screener, news and calendar exist
 * ONLY as classic embeds, so lib and components carry both generations
 * permanently.
 */
export function tvEmbedScript(widget: string): string {
  return `https://s3.tradingview.com/external-embedding/embed-widget-${widget}.js`;
}

/* ------------------------------------------------------------------ *
 * Widgets this panel refuses to embed
 * ------------------------------------------------------------------ */

/**
 * TradingView widgets that were asked for, verified, and deliberately NOT
 * shipped. Recorded here — with the reason — because the failure mode is
 * someone adding one back in good faith six months from now, and the
 * argument against it is not obvious from the widget's name.
 *
 * `technical-analysis` is the load-bearing entry. Mounted keyless on
 * 2026-09-06 for FX_IDC:XAUUSD it renders a speedometer reading
 * "Strong sell / Sell / Neutral / Buy / Strong buy" with an oscillator and
 * moving-average tally beneath it. That is precisely the aggregate verdict
 * this project refuses in two other places already:
 *
 *   - config/sources.yaml#tv_gc_technicals stores 17 raw indicator series
 *     and explicitly does NOT store Recommend.All / Recommend.MA /
 *     Recommend.Other, because "technicals annotate the macro read, they
 *     must not originate calls";
 *   - advancedChartConfig() below is pinned by a test asserting its JSON
 *     never contains "recommend", "buy", "sell" or "technicals".
 *
 * And CLAUDE.md's hard rule 6 is "No trading instructions. You advise on
 * market conditions; humans decide trades." A dial that says STRONG BUY on
 * the desk's own control panel is a trading instruction wearing a gauge.
 * The panel already draws Jamasp's own technical read — ridge-fitted signal
 * tiles over 38 columns, components/technical-map.tsx — which is a weighted
 * description of state, not a verdict.
 *
 * Note that the refusal covers BOTH generations. TradingView has since
 * rebuilt this one as a `<tv-technical-analysis>` web component whose
 * `ratings-display-mode` offers "gauge", "breakdown" or both — a breakdown
 * of verdicts is still verdicts, so the newer widget is refused on exactly
 * the same grounds and there is no version of it this panel wants.
 *
 * The three `seasonal*` entries are a different kind of entry: those SCRIPT
 * NAMES do not exist. All three 404 at s3.tradingview.com, verified
 * 2026-09-06. The seasonal chart itself is very much real — it is a web
 * component, `<tv-seasonal-chart>`, and the reference desk ships it (see
 * seasonalChartComponent below). These names are kept here so the next
 * person to reach for the classic spelling gets the answer rather than the
 * 404, because "the widget does not exist" was the wrong conclusion drawn
 * from exactly that evidence once already.
 */
export const TV_REFUSED_WIDGETS: Readonly<Record<string, string>> = {
  "technical-analysis":
    "renders an aggregate buy/sell verdict gauge; config/sources.yaml and " +
    "CLAUDE.md rule 6 both refuse aggregate calls",
  seasonals: "no such script — use the <tv-seasonal-chart> web component",
  seasonality: "no such script — use the <tv-seasonal-chart> web component",
  "seasonal-chart": "no such script — use the <tv-seasonal-chart> web component",
};

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

/* ------------------------------------------------------------------ *
 * The reference desk (/markets)
 * ------------------------------------------------------------------ */

/**
 * Everything below builds the third-party REFERENCE surface, and the word
 * matters: none of it is Jamasp's analysis, and the page says so out loud.
 *
 * The distinction is the whole design. Jamasp already scores news for gold
 * impact, fits its own technical weights and keeps its own event horizon; a
 * TradingView widget that quietly sat next to one of those would leave a
 * reader unable to tell whose read they were looking at. So the widgets that
 * overlap Jamasp's own work are either refused outright
 * (TV_REFUSED_WIDGETS), or given a job Jamasp demonstrably does NOT do —
 * breadth, an outside view, or a horizon Jamasp's own feed cannot reach.
 *
 * Names to be careful with: four of these widgets are not fetched from the
 * URL their product name suggests. The economic calendar is
 * `embed-widget-events.js`, the news timeline is `embed-widget-timeline.js`.
 * tvEmbedScript() takes the SCRIPT name, so every call below passes the
 * former, not the latter.
 */

/** Appearance a reference widget needs: just which way the panel is painted. */
export type TvTheme = "light" | "dark";

/**
 * `isTransparent: FALSE` on every classic reference widget — the opposite of
 * what the Mini Chart does, and arrived at the hard way.
 *
 * Transparency is the obvious choice here: it is what TV_THEME_TOKENS sets
 * for the web-component generation, and it is what makes a widget and the
 * card around it read as one object. It was tried first, and on these iframe
 * embeds it is actively broken. Mounted dark on a dark page, 2026-09-06:
 *
 *   screener       ignores `colorTheme` completely and renders its LIGHT
 *                  skin — a white table in the middle of a dark page.
 *                  Reordering the config keys changes nothing.
 *   timeline       renders, but drops its text to a low opacity meant to sit
 *                  over a chart, so every headline is grey-on-grey.
 *   events         same washed-out text.
 *   stock-heatmap  the only one that survives it, because it paints its own
 *                  opaque canvas regardless.
 *
 * Opaque is therefore the honest setting, and it costs something real: these
 * are iframes, so TV_THEME_TOKENS cannot reach inside them, `colorTheme`
 * offers exactly two values, and the surface TradingView paints is its own
 * neutral rather than the panel's `--card`. The widgets sit in the right
 * theme but not the exact ramp. app/markets/page.tsx does not pretend
 * otherwise, and the three widgets that DO take the palette are the
 * web-component ones above.
 *
 * The theme itself comes from the live <html> class on every rebuild
 * (components/tradingview-embed.tsx), never a guess — a `colorTheme` that
 * disagrees with the surface under it is exactly the failure above.
 */
const REFERENCE_BASE = (theme: TvTheme) => ({
  colorTheme: theme,
  isTransparent: false,
  locale: "en",
  width: "100%",
  height: "100%",
});

export type WatchlistGroup = {
  /** Tab label. Jamasp's own vocabulary, not TradingView's. */
  name: string;
  /**
   * Where the group comes from in Jamasp's config — printed under the widget
   * so a reader can trace any row back to something the agent actually reads.
   */
  provenance: string;
  symbols: readonly { name: string; displayName: string }[];
};

/**
 * "Gold plus everything that drives it" — derived from what Jamasp reads, not
 * from a generic macro list.
 *
 * The five groups ARE Jamasp's own taxonomy. Four of the names are theme
 * slugs from config/weights.yaml#themes (rates_dollar, physical_cb,
 * etf_flows + supply_mining, geopolitics) — the same list the fundamental
 * map's ridge fit indexes its feature columns by; the fifth is the instrument
 * itself. Grouping this way means the watchlist and the market map answer the
 * same question in two registers: the map says which theme the NEWS is
 * moving, this says what the PRICES in that theme are doing. Two unrelated
 * lists sharing a page would have been the easy version and a worse one.
 *
 * Every symbol below was mounted keyless and screenshotted on 2026-09-06.
 * Symbol search is not evidence — it returns tickers the widgets then refuse
 * — so nothing is here that was not seen to paint a real number.
 *
 * Traceability, row by row:
 *
 *   Gold complex
 *     FX_IDC:XAUUSD    the panel's own chart symbol (TV_LIVE_SYMBOL)
 *     BITFINEX:XAUTUSD jamasp/ingest/bars.py's deep-history fallback — the
 *                      XAUT/GC ratio is re-checked at fetch time (todo 015)
 *     XAG / XPT        the rest of the precious complex the desk quotes
 *
 *   Rates & dollar   -> theme `rates_dollar`
 *     PEPPERSTONE:USDX config/sources.yaml#dxy_intraday (DX-Y.NYB)
 *     PYTH:US10Y       config/sources.yaml#yield_10y_nominal (^TNX)
 *     PYTH:US02Y       the policy-path leg of state/watchlist.yaml's
 *                      `fed-rate-path` theme. Jamasp stores no 2y series, so
 *                      this row is breadth, not a mirror
 *     FX:USDJPY        config/sources.yaml#usdjpy (JPY=X)
 *     FX_IDC:EURUSD    the dollar index's dominant leg
 *
 *   Physical & CB    -> theme `physical_cb`
 *     FX_IDC:USDCNY    the cross config/sources.yaml#sge_benchmark's CNY/gram
 *                      print must be converted through before an
 *                      SGE-vs-London premium means anything
 *     FX_IDC:USDINR    India physical demand — the other half of the
 *                      east-of-Dubai bid this desk trades into
 *
 *   ETF & mining     -> themes `etf_flows` + `supply_mining`
 *     GLD, IAU         the ETF-flow bellwethers
 *     GDX, GDXJ, NEM   the equity read on mine supply, which is what
 *                      mining.com / Mining Weekly / Northern Miner
 *                      (config/sources.yaml) feed the map as news
 *
 *   Geopolitics & risk -> theme `geopolitics`, plus lib/drivers.ts's
 *                      "broader risk complex"
 *     TVC:UKOIL        Brent. gcaptain and Maritime Executive were added to
 *                      config/sources.yaml precisely because corridor
 *                      incidents move Brent >8% intraday and the general
 *                      feeds missed them; this is that theme's price
 *     CAPITALCOM:VIX   the risk-off gate
 *     SPREADEX:SPX     DRIVER_SPECS ^GSPC (a CFD — see DRIVER_TV_EMBEDS)
 *     BITSTAMP:BTCUSD  DRIVER_SPECS BTC-USD (one venue, not the aggregate)
 *
 * Two instruments the desk reads have NO row here, and their absence is
 * load-bearing rather than an oversight:
 *
 *   - the 10-year REAL yield (FRED:DFII10). The same wall DRIVER_TV_EMBEDS
 *     documents: the FRED "economic" class cannot render, and every quotable
 *     10y symbol is NOMINAL. ECONOMICS:USINTR was probed too and is
 *     permission-denied, so there is no policy-rate row either.
 *   - gold implied vol (^GVZ, config/sources.yaml#gold_vol). CBOE:GVZ is
 *     permission-denied keyless, verified 2026-09-06.
 *
 * Substituting a near-miss for either would put the wrong number under a
 * label the desk trusts — the exact failure the DFII10 test in
 * test/tradingview.test.ts exists to prevent. They stay missing, and
 * app/markets/page.tsx names them as missing.
 *
 * One more absence, for a different reason: NYSE:GOLD renders, but that
 * ticker is Barrick's old listing and is no longer an unambiguous name for
 * the company. A miner row that might be quoting a different issuer than its
 * label says is worse than four miner rows, so it was dropped.
 */
export const JAMASP_WATCHLIST: readonly WatchlistGroup[] = [
  {
    name: "Gold complex",
    provenance:
      "the instrument — spot, Jamasp's XAUT history fallback, and the precious complex",
    symbols: [
      { name: TV_LIVE_SYMBOL, displayName: "Gold spot" },
      { name: "BITFINEX:XAUTUSD", displayName: "Tether Gold" },
      { name: "FX_IDC:XAGUSD", displayName: "Silver" },
      { name: "FX_IDC:XPTUSD", displayName: "Platinum" },
    ],
  },
  {
    name: "Rates & dollar",
    provenance:
      "map theme rates_dollar · config/sources.yaml dxy_intraday, yield_10y_nominal, usdjpy",
    symbols: [
      { name: "PEPPERSTONE:USDX", displayName: "Dollar index" },
      { name: "PYTH:US02Y", displayName: "US 2y" },
      { name: "PYTH:US10Y", displayName: "US 10y" },
      { name: "FX:USDJPY", displayName: "USD/JPY" },
      { name: "FX_IDC:EURUSD", displayName: "EUR/USD" },
    ],
  },
  {
    name: "Physical & CB",
    provenance:
      "map theme physical_cb · the CNY cross the SGE premium needs, plus the India bid",
    symbols: [
      { name: "FX_IDC:USDCNY", displayName: "USD/CNY" },
      { name: "FX_IDC:USDINR", displayName: "USD/INR" },
    ],
  },
  {
    name: "ETF & mining",
    provenance:
      "map themes etf_flows + supply_mining · the equity read on flows and mine supply",
    symbols: [
      { name: "AMEX:GLD", displayName: "SPDR Gold" },
      { name: "AMEX:IAU", displayName: "iShares Gold" },
      { name: "AMEX:GDX", displayName: "Gold miners" },
      { name: "AMEX:GDXJ", displayName: "Junior miners" },
      { name: "NYSE:NEM", displayName: "Newmont" },
    ],
  },
  {
    name: "Geopolitics & risk",
    provenance:
      "map theme geopolitics + lib/drivers.ts risk complex · Brent, VIX, SPX, BTC",
    symbols: [
      { name: "TVC:UKOIL", displayName: "Brent" },
      { name: "CAPITALCOM:VIX", displayName: "VIX" },
      { name: "SPREADEX:SPX", displayName: "S&P 500" },
      { name: "BITSTAMP:BTCUSD", displayName: "Bitcoin" },
    ],
  },
];

/** Every symbol the reference desk mounts, deduplicated. */
export function watchlistSymbols(): string[] {
  return [...new Set(JAMASP_WATCHLIST.flatMap(g => g.symbols.map(s => s.name)))];
}

/* ---- the web-component half of the reference desk ---- */

/**
 * A modern web-component embed: a custom element and the attributes to set
 * on it.
 *
 * Three of the six reference widgets exist in BOTH generations, and they use
 * the new one on purpose rather than by preference:
 *
 *   - **weight.** Web components share one ES-module loader and one data
 *     connection across every instance on the page. Three of them cost one
 *     script and one socket; three classic embeds cost three full iframe
 *     document loads. On a page whose entire budget is third-party frames
 *     that is the difference that matters.
 *   - **theme.** Only this generation reads TV_THEME_TOKENS. Custom
 *     properties inherit through a shadow boundary even a closed one, which
 *     is why components/driver-panel.tsx can hand the Mini Charts the panel's
 *     own palette — and why the classic embeds below cannot be given
 *     anything but `colorTheme: "light" | "dark"`.
 *   - it is the generation TradingView currently documents; the classic
 *     `market-quotes` / `market-overview` scripts still serve but their doc
 *     pages are gone.
 *
 * The other three (heatmap, screener, news) plus the calendar have no
 * web-component version at all, so the panel carries both shells.
 *
 * Attribute names are kebab-case of TradingView's camelCase options, which
 * is their documented converter rule and not a guess. `true` means a bare
 * boolean attribute.
 */
export type TvComponentSpec = {
  tag: string;
  attrs: Readonly<Record<string, string | true>>;
};

/** Loader URL for a web component. Locale is a PATH segment, not an attribute. */
export function tvComponentScript(tag: string, locale = "en"): string {
  return `https://widgets.tradingview-widget.com/w/${locale}/${tag}.js`;
}

/**
 * Watchlist — `<tv-market-data>`, sectioned by Jamasp's own map themes.
 *
 * The page's centrepiece, and the one widget here with no Jamasp equivalent
 * at all: the overview's Drivers card carries six tiles because six is what
 * fits the grid, and every one of them is a stored reading. This is twenty
 * live rows with open/high/low, under the same theme headings the market map
 * groups news by.
 *
 * One honest loss against the retired classic widget, which took a
 * `displayName` per row: `symbolSectors` carries section names and bare
 * symbols only, so the ROWS are labelled in TradingView's vocabulary
 * ("UNITED STATES 2 YEAR GO…") rather than the desk's ("US 2y"). The
 * SECTIONS still carry Jamasp's taxonomy, which is the load-bearing half —
 * and the page prints the provenance line for each group underneath, so a
 * row can still be traced back to a source. Worth it for one shared socket
 * instead of a second iframe.
 */
export function watchlistComponent(): TvComponentSpec {
  return {
    tag: "tv-market-data",
    attrs: {
      view: "overview",
      "symbol-sectors": JSON.stringify(
        JAMASP_WATCHLIST.map(g => ({
          sectionName: g.name,
          symbols: g.symbols.map(s => s.name),
        })),
      ),
    },
  };
}

/**
 * World market summary — `<tv-world-market-summary>`.
 *
 * Genuinely a different widget from anything else here: country-level equity
 * index performance, on a choropleth the reader can flip to a ranked list.
 * Its job on a gold desk is the risk map — where the selling actually is —
 * and it is the only thing on the panel that answers that geographically.
 *
 * `sort: "performance"` rather than alphabetical because the question is
 * always "who moved", never "how do I find Belgium". The view toggle is left
 * on: map and list answer the same question at different resolutions and
 * neither is right for every reader.
 */
export function worldMarketSummaryComponent(): TvComponentSpec {
  return {
    tag: "tv-world-market-summary",
    attrs: { view: "map", sort: "performance" },
  };
}

/**
 * Seasonal chart — `<tv-seasonal-chart>`, on gold spot.
 *
 * Nearly written off. The classic generation has no such widget —
 * embed-widget-seasonals.js, -seasonality.js and -seasonal-chart.js all 404,
 * which is why TV_REFUSED_WIDGETS still lists those three names — but it
 * exists as a web component and renders five years of gold overlaid on a
 * calendar-month axis with an average line. The lesson is worth keeping:
 * "no such widget" was true of the generation probed and false of the
 * product.
 *
 * It earns its place because gold's seasonality is a real physical-demand
 * phenomenon rather than a chart artefact — the Indian wedding and festival
 * buying that config/sources.yaml tracks through Gulf and regional feeds,
 * and Chinese New Year restocking behind the SGE benchmark. This is the only
 * surface on the panel that shows the shape of a year, and Jamasp's own
 * stored bars do not go back far enough to draw it.
 *
 * `show-average` is the whole point — a single year's line is an anecdote.
 */
export function seasonalChartComponent(symbol = TV_LIVE_SYMBOL): TvComponentSpec {
  return {
    tag: "tv-seasonal-chart",
    attrs: { symbol, "show-average": true },
  };
}

/**
 * Stock heatmap — the equity market's risk temperature in one picture.
 *
 * Framed as a RISK read, not a gold instrument, because that is honestly all
 * it is: lib/drivers.ts carries ^GSPC as a single number in the "broader risk
 * complex", and this is that number decomposed. On a day when gold and
 * equities move together, the decomposition is what says which story it was.
 *
 * The S&P is the default because AllUSA renders thousands of unreadable
 * micro-cap tiles. Unlike the gold chart, the top bar is LEFT ON: nothing
 * else on the panel quotes this widget, so a reader retuning it to another
 * market breaks no caption — where the Advanced Chart's symbol lock exists
 * precisely because its caption promises an instrument.
 */
export function heatmapConfig(theme: TvTheme) {
  return {
    ...REFERENCE_BASE(theme),
    dataSource: "SPX500",
    blockSize: "market_cap_basic",
    blockColor: "change",
    grouping: "sector",
    hasTopBar: true,
    isDataSetEnabled: true,
    isZoomEnabled: true,
    hasSymbolTooltip: true,
    isMonoSize: false,
    symbolUrl: "",
  };
}

/**
 * Screener — pointed at FOREX, not at stocks, and that is a deliberate
 * departure from what was asked for.
 *
 * Two things drove it. First, relevance: `market: "america"` cannot be scoped
 * to gold miners by any option the widget exposes, so a stock screener on
 * this panel is nine thousand tickers of noise for a desk that trades one
 * metal. Second, and decisive: the `overview` column set renders a
 * **"Technical Rating: Strong Sell / Sell / Buy"** column — the aggregate
 * verdict TV_REFUSED_WIDGETS explains this project refuses. Verified by
 * mounting, 2026-09-06.
 *
 * `defaultColumn: "performance"` carries no rating column, and forex gives 49
 * rows of majors and minors across seven horizons — real breadth Jamasp does
 * not have, since config/sources.yaml stores exactly one FX cross (JPY=X) and
 * one dollar index. Gold is a dollar trade; how the dollar is doing against
 * everything else is context available nowhere else on this panel.
 *
 * `defaultScreen: "general"` rather than a ranked preset: TradingView
 * disables most_capitalized, volume_leaders, unusual_volume,
 * high_dividend and earnings_this_week in forex mode, and a screen the widget
 * has disabled is a silently empty panel waiting to happen.
 */
export function screenerConfig(theme: TvTheme) {
  return {
    ...REFERENCE_BASE(theme),
    market: "forex",
    defaultColumn: "performance",
    defaultScreen: "general",
    showToolbar: true,
  };
}

/**
 * News — TradingView's "timeline" widget, scoped to the gold symbol.
 *
 * This is the widget with the strongest case against it, and what saved it is
 * what it turned out to BE. Jamasp runs ~20 RSS sources through dedupe,
 * five-tier triage and a gold-impact score; a raw wire beside that would
 * shadow the product and muddle provenance.
 *
 * But `feedMode: "symbol"` on FX_IDC:XAUUSD is not a wire. Mounted on
 * 2026-09-06 it carried a dozen items reaching back over three months —
 * TradingView's own editorial gold notes, two to four a month, the newest
 * several days old. It cannot compete with the inbox on volume or recency
 * and will never be mistaken for it. What it offers is an OUTSIDE view:
 * somebody else's framing of the same tape, useful exactly when Jamasp's
 * stance has gone unchallenged for a while.
 *
 * `feedMode: "market"` was tried first and there is no commodity feed — the
 * documented markets are crypto, forex, stock, index, futures and cfd, and
 * `market: "commodity"` renders "Oops! Something went wrong". The symbol feed
 * is the only one that reaches this instrument. `market` is deliberately
 * absent from the payload rather than set and ignored: TradingView's own
 * generator deletes whichever of market/symbol does not match feedMode.
 *
 * `displayMode: "adaptive"` switches between the roomy and compact layouts on
 * container width, which is what a card that has to survive 390px needs.
 */
export function newsConfig(theme: TvTheme) {
  return {
    ...REFERENCE_BASE(theme),
    feedMode: "symbol",
    symbol: TV_LIVE_SYMBOL,
    displayMode: "adaptive",
  };
}

/**
 * Countries the calendar filters to, and why each one is on the list.
 *
 * Not a generic G10 set — every entry traces to something Jamasp reads:
 *
 *   us  config/sources.yaml fed_press, bls_latest, treasury_press
 *   eu  ecb_press
 *   gb  boe_news
 *   jp  usdjpy — the carry leg the desk watches through JPY=X
 *   cn  sge_benchmark — Shanghai physical demand
 *   in  the India physical bid this desk trades into
 *
 * These are ISO 3166-1 alpha-2 country codes (plus `eu` for the union), not
 * currency codes, and the widget silently shows nothing for a code it does
 * not know — so the list is pinned by a test.
 */
export const TV_CALENDAR_COUNTRIES = ["us", "eu", "gb", "jp", "cn", "in"] as const;

/**
 * Economic calendar — TradingView's "events" widget.
 *
 * The only reference widget that does NOT live on /markets. It belongs beside
 * Jamasp's own calendar, because the two answer adjacent questions and the
 * comparison is the point: /calendar's list is what Jamasp is WATCHING, drawn
 * from the ff_calendar source, and docs/todo/001 records that this source
 * ships one week at a time — so Jamasp's horizon runs out at the end of the
 * current week, every week. This widget sees past that edge. It is reference
 * data, under Jamasp's list, labelled as reference, and it is the closest
 * thing on the panel to an answer to todo 001.
 *
 * `importanceFilter: "0,1"` is medium and high only — the same tiers
 * `jamasp calendar` prints. The grammar is a comma-separated set of -1 (low),
 * 0 (medium) and 1 (high); "-1,0,1" is TradingView's default and was tried,
 * whereupon the widget filled with New Zealand reserve totals and Vietnamese
 * motorbike sales. That is how a calendar stops being read.
 */
export function economicCalendarConfig(theme: TvTheme) {
  return {
    ...REFERENCE_BASE(theme),
    importanceFilter: "0,1",
    countryFilter: TV_CALENDAR_COUNTRIES.join(","),
  };
}
