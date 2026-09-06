import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  advancedChartConfig, DRIVER_TV_EMBEDS, liveGoldSymbol, JAMASP_TV_SYMBOL,
  TV_LIVE_SYMBOL, TV_MINI_CHART_SCRIPT, TV_PALETTE_ROLES, TV_SCRIPT_SRC,
  TV_THEME_TOKENS, TV_TICKER_TAPE_HEIGHT, TV_TICKER_TAPE_SCRIPT,
  tickerTapeAttributes, tickerTapeSymbols, tvEmbedFor,
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
