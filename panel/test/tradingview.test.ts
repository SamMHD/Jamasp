import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  advancedChartConfig, liveGoldSymbol, JAMASP_TV_SYMBOL, TV_LIVE_SYMBOL,
} from "../lib/tradingview";

const LOOK = { theme: "dark", backgroundColor: "#0a0b0a", gridColor: "#333330" } as const;

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
