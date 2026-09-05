/**
 * TradingView embed wiring for the technical panel's live gold chart.
 *
 * Pure — no DOM, no window — so the symbol resolution and the widget config
 * are both unit-testable and the client component stays a thin mounting
 * shell.
 *
 * WHY A WIDGET AT ALL: every number this panel draws is a *stored* reading.
 * `prices.GC` carries the market bar timestamp, so on a frozen feed (or any
 * weekend) the hero figure was a day old while looking exactly like a live
 * quote. The widget supplies the live half of that comparison; Jamasp's own
 * reading sits beside it, labelled and aged, so the desk can see at a glance
 * whether the two agree.
 */

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

/** TradingView's own loader for the Advanced Chart embed. */
export const TV_SCRIPT_SRC =
  "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

/**
 * EXCHANGE:TICKER, the only shape TradingView accepts. Anything else came
 * from an override that no longer means what this module assumes, so it
 * falls back rather than handing the widget a string that renders an
 * "invalid symbol" box.
 */
const SYMBOL_RE = /^[A-Z0-9_]{2,12}:[A-Za-z0-9._!+-]{1,20}$/;

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

export type ChartAppearance = {
  theme: "light" | "dark";
  /** Resolved values of --background / --border, read off the live root. */
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
