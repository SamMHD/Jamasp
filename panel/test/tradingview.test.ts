import { describe, expect, it } from "vitest";
import { DRIVER_TV_EMBEDS, TV_MINI_CHART_SCRIPT, tvEmbedFor } from "../lib/tradingview";
import { DRIVER_SPECS } from "../lib/drivers";

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

  it("loads the widget from TradingView's own module host over https", () => {
    expect(TV_MINI_CHART_SCRIPT).toMatch(/^https:\/\/widgets\.tradingview-widget\.com\//);
  });
});
