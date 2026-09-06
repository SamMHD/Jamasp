import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  advancedChartConfig, DRIVER_TV_EMBEDS, economicCalendarConfig, heatmapConfig,
  JAMASP_TV_SYMBOL, JAMASP_WATCHLIST, liveGoldSymbol, newsConfig, screenerConfig,
  seasonalChartComponent, tickerTapeAttributes, tickerTapeSymbols,
  TV_CALENDAR_COUNTRIES, TV_LIVE_SYMBOL, TV_MINI_CHART_SCRIPT, TV_PALETTE_ROLES,
  TV_REFUSED_WIDGETS, TV_SCRIPT_SRC, TV_THEME_TOKENS, TV_TICKER_TAPE_HEIGHT,
  TV_TICKER_TAPE_SCRIPT, tvComponentScript, tvEmbedFor, tvEmbedScript,
  watchlistComponent, watchlistSymbols,
} from "../lib/tradingview";
import { DRIVER_SPECS } from "../lib/drivers";

const LOOK = { theme: "dark", backgroundColor: "#0a0b0a", gridColor: "#333330" } as const;

describe("tvEmbedFor", () => {
  it("maps every driver that has a verified TradingView equivalent", () => {
    expect(tvEmbedFor("DX-Y.NYB")?.symbol).toBe("PEPPERSTONE:USDX");
    expect(tvEmbedFor("^TNX")?.symbol).toBe("PYTH:US10Y");
    expect(tvEmbedFor("USDJPY")?.symbol).toBe("FX:USDJPY");
    expect(tvEmbedFor("^GSPC")?.symbol).toBe("SPREADEX:SPX");
    expect(tvEmbedFor("BTC-USD")?.symbol).toBe("BITSTAMP:BTCUSD");
  });

  it("refuses to map the 10-year REAL yield", () => {
    // The load-bearing assertion of this file. TradingView carries DFII10
    // only as an "economic" FRED series its free widget cannot render, and
    // the only quotable 10y symbols are NOMINAL. Mapping this driver to any
    // of them would put nominal yield where the desk reads real yield —
    // silently, and on one of gold's primary drivers. The tile stays
    // Jamasp-sourced instead. See lib/tradingview.ts.
    expect(tvEmbedFor("DFII10")).toBeNull();
    const symbols = Object.values(DRIVER_TV_EMBEDS).map(e => e.symbol);
    expect(symbols).not.toContain("PYTH:US10Y10Y");
    expect(symbols.filter(s => s.endsWith("US10Y"))).toHaveLength(1);
  });

  it("returns null for a symbol that is not a driver at all", () => {
    expect(tvEmbedFor("GC")).toBeNull();
    expect(tvEmbedFor("")).toBeNull();
  });

  it("leaves the drivers card sorted live-first, ours-last", () => {
    // Not a cosmetic ordering. Scattered through the grid, a tile with no
    // widget reads as the one whose embed failed; gathered at the end, the
    // card reads "five live, one ours". The invariant is that the mapped
    // drivers form a PREFIX of DRIVER_SPECS — no unmapped driver may sit
    // between two mapped ones.
    const mapped = DRIVER_SPECS.map(s => tvEmbedFor(s.symbol) !== null);
    expect(mapped.indexOf(false)).toBe(mapped.lastIndexOf(true) + 1);
  });

  it("only maps symbols the drivers card actually renders", () => {
    const driverSymbols = new Set(DRIVER_SPECS.map(s => s.symbol));
    for (const key of Object.keys(DRIVER_TV_EMBEDS)) {
      expect(driverSymbols, `${key} is mapped but is not a driver`).toContain(key);
    }
  });

  it("carries a verified time frame on every embed", () => {
    // A symbol that refuses its range renders "Unsupported interval" instead
    // of a chart, so the range is part of the verified mapping, not a default.
    for (const [key, embed] of Object.entries(DRIVER_TV_EMBEDS)) {
      expect(embed.timeFrame, `${key} has no time frame`).toBeTruthy();
      expect(embed.symbol, `${key} needs an exchange prefix`).toContain(":");
    }
  });

  it("keeps the gold chart's symbol out of the drivers table", () => {
    // The two widgets share this module but not their symbol tables: the
    // Drivers card looks up every cell in DRIVER_TV_EMBEDS, so gold's chart
    // symbol living there would be a mapping nothing renders — and would
    // start failing "only maps symbols the drivers card actually renders"
    // the moment someone trusted it.
    expect(Object.values(DRIVER_TV_EMBEDS).map(e => e.symbol))
      .not.toContain(TV_LIVE_SYMBOL);
  });
});

describe("liveGoldSymbol", () => {
  it("defaults to the spot feed the keyless widget can actually render", () => {
    // Verified against the live embed 2026-09-05: every CME-group futures
    // symbol (COMEX:GC1!, COMEX_MINI:GC1!, CME:GC1!, NYMEX:GC1!) renders an
    // empty chart because the free widget has no CME data entitlement, while
    // every XAU/USD feed renders. A blank box would be worse than spot.
    expect(liveGoldSymbol({})).toBe(TV_LIVE_SYMBOL);
    expect(TV_LIVE_SYMBOL).toBe("FX_IDC:XAUUSD");
  });

  it("takes an operator override from config/settings.yaml", () => {
    // The escape hatch that matters: an account WITH CME data can repoint
    // this at the exact contract Jamasp reads, without a code change.
    expect(liveGoldSymbol({ panel: { tradingview_symbol: "COMEX:GC1!" } }))
      .toBe("COMEX:GC1!");
    expect(liveGoldSymbol({ panel: { tradingview_symbol: "  TVC:GOLD  " } }))
      .toBe("TVC:GOLD");
  });

  it("falls back rather than handing TradingView a shape it cannot resolve", () => {
    for (const panel of [
      { tradingview_symbol: "GC1!" },              // no exchange
      { tradingview_symbol: "<script>" },
      { tradingview_symbol: "" },
      { tradingview_symbol: 42 },
      {},
    ]) {
      expect(liveGoldSymbol({ panel }), JSON.stringify(panel)).toBe(TV_LIVE_SYMBOL);
    }
    expect(liveGoldSymbol({ panel: "nonsense" })).toBe(TV_LIVE_SYMBOL);
  });

  /**
   * JAMASP_TV_SYMBOL is the contract Jamasp actually prices off, and it is
   * what the override above should be set to the day CME data is available.
   * If someone repoints the scanner source at a different instrument, this
   * constant has to move with it — so pin the two together rather than
   * letting the panel quietly describe the wrong contract.
   */
  it("names the same contract config/sources.yaml reads", () => {
    const yaml = readFileSync(
      path.resolve(import.meta.dirname, "../../config/sources.yaml"), "utf8");
    const line = yaml.split("\n").find(l => l.includes("scanner.tradingview.com"));
    expect(line, "config/sources.yaml no longer has a TradingView scanner URL").toBeTruthy();
    const encoded = /[?&]symbol=([^&"]+)/.exec(line!)?.[1];
    expect(encoded, "the scanner URL carries no symbol param").toBeTruthy();
    expect(decodeURIComponent(encoded!)).toBe(JAMASP_TV_SYMBOL);
  });
});

describe("advancedChartConfig", () => {
  it("carries the symbol, the panel's own palette, and hourly UTC candles", () => {
    const cfg = advancedChartConfig(TV_LIVE_SYMBOL, LOOK);
    expect(cfg.symbol).toBe(TV_LIVE_SYMBOL);
    expect(cfg.theme).toBe("dark");
    expect(cfg.backgroundColor).toBe("#0a0b0a");
    expect(cfg.gridColor).toBe("#333330");
    // Hourly matches the GC bars Jamasp stores; UTC matches every other
    // timestamp on the panel (lib/format.ts#fmtUtc).
    expect(cfg.interval).toBe("60");
    expect(cfg.timezone).toBe("Etc/UTC");
    expect(cfg.autosize).toBe(true);
  });

  it("locks the instrument down — a passer-by must not be able to retune it", () => {
    const cfg = advancedChartConfig(TV_LIVE_SYMBOL, LOOK);
    expect(cfg.allow_symbol_change).toBe(false);
    expect(cfg.save_image).toBe(false);
  });

  it("never asks TradingView for an aggregate verdict", () => {
    // config/sources.yaml: technicals annotate the macro read, they must not
    // originate calls. The ingest side refuses to store Recommend.*; the
    // widget must not display it either.
    const json = JSON.stringify(advancedChartConfig(TV_LIVE_SYMBOL, LOOK)).toLowerCase();
    for (const word of ["recommend", "buy", "sell", "technicals"]) {
      expect(json, `config asks for "${word}"`).not.toContain(word);
    }
  });
});

describe("tickerTapeSymbols", () => {
  it("is the drivers card's own line-up, in the card's own order", () => {
    // Membership and order are DERIVED from DRIVER_SPECS rather than listed
    // again, so the band across the top of the overview and the grid further
    // down can never disagree about what the complex is or how it reads.
    const tape = tickerTapeSymbols(DRIVER_SPECS.map(s => s.symbol));
    const expected = DRIVER_SPECS
      .map(s => tvEmbedFor(s.symbol)?.symbol)
      .filter((s): s is string => s !== undefined);
    expect(tape).toEqual(expected);
    expect(tape).toEqual(
      ["PEPPERSTONE:USDX", "PYTH:US10Y", "FX:USDJPY", "SPREADEX:SPX", "BITSTAMP:BTCUSD"]);
  });

  it("drops the real yield with no special case of its own", () => {
    // The tape carries no DFII10 rule; it inherits the null that keeps a
    // nominal yield out of the Drivers grid. One guarantee, one implementation.
    expect(tickerTapeSymbols(["DFII10"])).toEqual([]);
    expect(tickerTapeSymbols(DRIVER_SPECS.map(s => s.symbol))).toHaveLength(5);
  });

  it("ignores symbols that are not drivers at all", () => {
    expect(tickerTapeSymbols(["GC", "", "DX-Y.NYB"])).toEqual(["PEPPERSTONE:USDX"]);
    expect(tickerTapeSymbols([])).toEqual([]);
  });
});

describe("tickerTapeAttributes", () => {
  it("passes symbols comma-separated, which is the converter the widget installs", () => {
    // A JSON array here does not fail loudly — it parses as one long nonsense
    // ticker and the band renders empty. Pin the shape.
    const attrs = tickerTapeAttributes(["FX:USDJPY", "PYTH:US10Y"]);
    expect(attrs.symbols).toBe("FX:USDJPY,PYTH:US10Y");
    expect(attrs.symbols).not.toContain("[");
  });

  it("asks for the compact row the reserved band is sized for", () => {
    // The strip reserves TV_TICKER_TAPE_HEIGHT from the server render onward,
    // and the widget's own row height at this item size is what that number
    // IS. Asking for a different size would make the band clip or gap.
    expect(tickerTapeAttributes([])["item-size"]).toBe("compact");
    expect(tickerTapeAttributes([]).direction).toBe("horizontal");
    expect(TV_TICKER_TAPE_HEIGHT).toBe(48);
  });

  it("leaves the theme to the mounting component", () => {
    // `theme` is the one attribute that changes after mount (the appearance
    // toggle), so it belongs to the component that owns the theme bridge — a
    // value baked in here would go stale on the reader's first toggle.
    expect(tickerTapeAttributes(["FX:USDJPY"])).not.toHaveProperty("theme");
  });

  it("lets the panel's own surface show through", () => {
    expect(tickerTapeAttributes([])).toHaveProperty("transparent");
  });
});

describe("loaders", () => {
  it("loads each widget from TradingView's own host over https", () => {
    expect(TV_MINI_CHART_SCRIPT).toMatch(/^https:\/\/widgets\.tradingview-widget\.com\//);
    expect(TV_TICKER_TAPE_SCRIPT).toMatch(/^https:\/\/widgets\.tradingview-widget\.com\//);
    expect(TV_SCRIPT_SRC).toMatch(/^https:\/\/s3\.tradingview\.com\//);
  });

  it("keeps the two web components on separate modules", () => {
    // One script per element: components/tv-widget.tsx keys its loader
    // singleton on the src, so two tags sharing a URL would leave the second
    // waiting forever on a definition the first module never registers.
    expect(TV_TICKER_TAPE_SCRIPT).not.toBe(TV_MINI_CHART_SCRIPT);
  });
});

describe("theme tokens", () => {
  /**
   * The two widget generations take colour differently — the Mini Chart
   * reads CSS custom properties, the Advanced Chart bakes hex into its JSON
   * config — but both must name the SAME panel tokens. That is the whole
   * reason these two embeds share one module, so it is worth a test: a
   * palette retune that moves `--border` should move the chart grid and the
   * tile scales together, not one of them.
   */
  it("drives every widget colour off the shared palette roles", () => {
    for (const [prop, value] of Object.entries(TV_THEME_TOKENS)) {
      if (value === "transparent") continue;
      const token = /^var\((--[a-z-]+)\)$/.exec(value)?.[1];
      expect(token, `${prop} is not a var() of a palette token`).toBeTruthy();
      expect(Object.values(TV_PALETTE_ROLES) as string[],
        `${prop} names ${token}, which is not in TV_PALETTE_ROLES`).toContain(token!);
    }
  });

  it("keeps the mini chart transparent and the advanced chart opaque", () => {
    // Deliberate asymmetry: the tile lets its own surface show through so the
    // widget cells and the Jamasp-sourced DFII10 cell read as one family,
    // while the full-bleed chart canvas needs a real colour behind it.
    expect(TV_THEME_TOKENS["--tv-widget-background-color"]).toBe("transparent");
    expect(TV_PALETTE_ROLES.background).toBe("--background");
    expect(TV_PALETTE_ROLES.grid).toBe("--border");
  });
});

/* ------------------------------------------------------------------ *
 * The reference desk
 * ------------------------------------------------------------------ */

describe("the reference desk's widget catalogue", () => {
  it("builds the classic loader URL from the SCRIPT name", () => {
    // Four of these widgets are not served from the URL their product name
    // suggests, and guessing gives a 404: the economic calendar is `events`,
    // the news timeline is `timeline`.
    expect(tvEmbedScript("events")).toBe(
      "https://s3.tradingview.com/external-embedding/embed-widget-events.js");
    expect(tvEmbedScript("timeline")).toMatch(/embed-widget-timeline\.js$/);
    expect(tvEmbedScript("stock-heatmap")).toMatch(/^https:\/\/s3\.tradingview\.com\//);
  });

  it("puts the web component's locale in the path, not an attribute", () => {
    // TradingView's documented shape. A `locale` attribute is silently
    // ignored, so getting this wrong yields an English widget and no error.
    expect(tvComponentScript("tv-market-data"))
      .toBe("https://widgets.tradingview-widget.com/w/en/tv-market-data.js");
    expect(tvComponentScript("tv-seasonal-chart", "ar_AE"))
      .toContain("/w/ar_AE/tv-seasonal-chart.js");
  });

  /**
   * The load-bearing assertion of this section, and the sibling of the DFII10
   * test above: both exist to stop a future change from quietly putting
   * something on this panel that the project has already argued against.
   *
   * TradingView's Technical Analysis widget renders an aggregate
   * "Strong sell / Sell / Neutral / Buy / Strong buy" gauge. config/
   * sources.yaml refuses to STORE that verdict (Recommend.All / .MA / .Other
   * are deliberately absent from tv_gc_technicals), advancedChartConfig
   * refuses to ASK for it, and CLAUDE.md rule 6 forbids trading instructions
   * outright. Displaying it would defeat all three at once.
   */
  it("refuses the aggregate buy/sell widget, in either generation", () => {
    expect(TV_REFUSED_WIDGETS["technical-analysis"]).toBeTruthy();
    expect(TV_REFUSED_WIDGETS["technical-analysis"]).toMatch(/verdict|aggregate/i);
  });

  it("never mounts a refused widget", () => {
    // Walks the real call sites rather than trusting the constant: the
    // component file is what actually decides, and a new <TradingViewEmbed
    // widget="technical-analysis"> would be invisible to a test that only
    // read the map.
    const src = readFileSync(
      path.resolve(import.meta.dirname, "../components/tradingview-embed.tsx"), "utf8");
    for (const name of Object.keys(TV_REFUSED_WIDGETS)) {
      expect(src, `components/tradingview-embed.tsx mounts refused widget "${name}"`)
        .not.toMatch(new RegExp(`widget=["']${name}["']`));
    }
  });

  it("keeps every reference config on the panel's own appearance", () => {
    for (const build of [heatmapConfig, screenerConfig, newsConfig, economicCalendarConfig]) {
      for (const theme of ["light", "dark"] as const) {
        const cfg = build(theme) as Record<string, unknown>;
        expect(cfg.colorTheme, `${build.name} ignores the theme`).toBe(theme);
        // OPAQUE, and this assertion is the scar tissue. `isTransparent: true`
        // is the tempting setting — it is what TV_THEME_TOKENS does for the
        // web components — and on these iframe embeds it breaks them:
        // verified 2026-09-06, the screener ignores colorTheme entirely and
        // renders a white table on a dark page, while the news timeline and
        // the calendar drop their text to an unreadable opacity. Only the
        // heatmap survives it. See lib/tradingview.ts#REFERENCE_BASE.
        expect(cfg.isTransparent, `${build.name} is transparent again`).toBe(false);
        expect(cfg.width).toBe("100%");
        expect(cfg.height).toBe("100%");
      }
    }
  });
});

describe("the drivers watchlist", () => {
  it("groups by Jamasp's own map themes, not a generic macro list", () => {
    // The names here must stay recognisable against config/weights.yaml's
    // theme slugs: that shared vocabulary is what lets a reader carry a
    // finding from the market map to this table and back.
    expect(JAMASP_WATCHLIST.map(g => g.name)).toEqual([
      "Gold complex", "Rates & dollar", "Physical & CB", "ETF & mining",
      "Geopolitics & risk",
    ]);
    for (const group of JAMASP_WATCHLIST) {
      expect(group.provenance.length, `${group.name} has no provenance`)
        .toBeGreaterThan(20);
      expect(group.symbols.length, `${group.name} is empty`).toBeGreaterThan(0);
    }
  });

  it("carries the panel's own gold symbol as the first row", () => {
    // The watchlist and the overview's live chart must agree about what
    // "gold" means here — both spot, both FX_IDC, so a reader comparing the
    // two pages is comparing the same instrument.
    expect(JAMASP_WATCHLIST[0].symbols[0].name).toBe(TV_LIVE_SYMBOL);
  });

  it("only carries exchange-prefixed symbols, each named once", () => {
    const all = watchlistSymbols();
    for (const symbol of all) {
      expect(symbol, `${symbol} needs an exchange prefix`).toContain(":");
    }
    const raw = JAMASP_WATCHLIST.flatMap(g => g.symbols.map(s => s.name));
    expect(raw.length, "a symbol appears in two groups").toBe(all.length);
  });

  /**
   * The same refusal DRIVER_TV_EMBEDS makes, restated where the temptation
   * recurs. A watchlist is exactly the surface where somebody adds "US 10y
   * real" because there is a gap in the table — and TradingView's only
   * quotable 10y symbols are NOMINAL. Putting one under a real-yield label
   * would corrupt the primary gold driver silently.
   *
   * Gold implied vol is the same story: Jamasp reads ^GVZ, CBOE:GVZ is
   * permission-denied keyless, and no substitute exists.
   */
  it("substitutes nothing for the real yield or for gold vol", () => {
    const all = watchlistSymbols();
    expect(all.filter(s => /US\d+Y$/.test(s)).length).toBeGreaterThan(0);
    for (const forbidden of ["FRED:DFII10", "CBOE:GVZ", "ECONOMICS:USINTR"]) {
      expect(all, `${forbidden} does not render keyless`).not.toContain(forbidden);
    }
    // Nothing in the table may be LABELLED as a real yield or as gold vol,
    // whatever symbol is behind it.
    const labels = JAMASP_WATCHLIST
      .flatMap(g => g.symbols.map(s => s.displayName.toLowerCase()));
    for (const label of labels) {
      expect(label, `"${label}" claims to be a real yield`).not.toMatch(/real/);
      expect(label, `"${label}" claims to be gold vol`).not.toMatch(/gvz|implied vol/);
    }
  });

  it("hands the web component sections, not TradingView's default symbols", () => {
    const spec = watchlistComponent();
    expect(spec.tag).toBe("tv-market-data");
    const sectors = JSON.parse(spec.attrs["symbol-sectors"] as string) as
      { sectionName: string; symbols: string[] }[];
    expect(sectors.map(s => s.sectionName)).toEqual(JAMASP_WATCHLIST.map(g => g.name));
    expect(sectors.flatMap(s => s.symbols)).toEqual(
      JAMASP_WATCHLIST.flatMap(g => g.symbols.map(s => s.name)));
    // TradingView's own starter list, which must never survive into ours.
    expect(spec.attrs["symbol-sectors"]).not.toContain("NASDAQ:AAPL");
  });
});

describe("the seasonal chart", () => {
  it("is a web component — the classic script names are dead", () => {
    // Recorded because "the widget does not exist" was the wrong conclusion
    // drawn from these 404s once already.
    const spec = seasonalChartComponent();
    expect(spec.tag).toBe("tv-seasonal-chart");
    expect(spec.attrs.symbol).toBe(TV_LIVE_SYMBOL);
    for (const dead of ["seasonals", "seasonality", "seasonal-chart"]) {
      expect(TV_REFUSED_WIDGETS[dead]).toContain("tv-seasonal-chart");
    }
  });

  it("always draws the average — one year's line is an anecdote", () => {
    expect(seasonalChartComponent().attrs["show-average"]).toBe(true);
  });
});

describe("the economic calendar", () => {
  it("filters to the economies Jamasp's own sources cover", () => {
    // Each code traces to a source in config/sources.yaml (fed/bls, ecb, boe)
    // or to an instrument the desk reads (JPY=X, the SGE benchmark, the
    // India bid). These are ISO country codes, and the widget shows nothing
    // at all for one it does not recognise.
    expect([...TV_CALENDAR_COUNTRIES]).toEqual(["us", "eu", "gb", "jp", "cn", "in"]);
    expect(economicCalendarConfig("light").countryFilter).toBe("us,eu,gb,jp,cn,in");
  });

  it("shows medium and high impact only, matching `jamasp calendar`", () => {
    // The grammar is -1 (low), 0 (medium), 1 (high). Including -1 fills the
    // widget with New Zealand reserve totals and stops it being read.
    expect(economicCalendarConfig("dark").importanceFilter).toBe("0,1");
  });
});

describe("the screener", () => {
  /**
   * Both of these encode the reason the screener is pointed at forex rather
   * than at the stocks that were asked for. The `overview` column set renders
   * a "Technical Rating: Strong Sell / Sell / Buy" column — the same
   * aggregate verdict the technical-analysis widget was refused over — and
   * `market: "america"` cannot be scoped to gold by any option the widget
   * exposes.
   */
  it("never asks for the column set that carries a buy/sell rating", () => {
    expect(screenerConfig("light").defaultColumn).toBe("performance");
    expect(screenerConfig("light").defaultColumn).not.toBe("overview");
  });

  it("screens the dollar's crosses, not US equities", () => {
    expect(screenerConfig("light").market).toBe("forex");
    // TradingView disables most_capitalized, volume_leaders, unusual_volume,
    // high_dividend and earnings_this_week in forex mode; a disabled screen
    // is a silently empty panel.
    expect(screenerConfig("light").defaultScreen).toBe("general");
  });
});

describe("the news timeline", () => {
  it("asks for the gold symbol's feed and nothing else", () => {
    const cfg = newsConfig("light") as Record<string, unknown>;
    expect(cfg.feedMode).toBe("symbol");
    expect(cfg.symbol).toBe(TV_LIVE_SYMBOL);
    // TradingView's generator deletes whichever of market/symbol does not
    // match feedMode, and there is no commodity market anyway — `market:
    // "commodity"` renders "Oops! Something went wrong".
    expect(cfg.market, "market must be absent in symbol mode").toBeUndefined();
  });
});
