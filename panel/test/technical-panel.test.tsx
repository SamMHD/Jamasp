import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TechnicalPanel } from "../components/technical-panel";
import type { PricePoint } from "../lib/db";
import type { GoldTechnicals } from "../lib/technicals";
import { getMessages } from "../lib/i18n";
import { deriveTechnicals } from "../lib/technicals";
import fa from "../messages/fa.json";

const NOW = new Date("2026-08-01T12:00:00Z");
const messages = getMessages("en");

const full: GoldTechnicals = {
  spot: { value: 3325, ts: "2026-08-01T08:00:00Z", delta24h: 14.5, pct24h: 0.438 },
  levels: [
    { label: "200DMA", value: 3400, kind: "ma", side: "above" },
    { label: "spot", value: 3325, kind: "spot", side: "at" },
    { label: "50DMA", value: 3250, kind: "ma", side: "below" },
  ],
  regime: "above 50DMA, below 200DMA",
  indicators: { rsi14: 58.4, atr14: 42.1, gvz: 18.7, netSpec: 9.5 },
  indicatorsAsOf: "2026-08-01T06:00:00Z",
  stale: false,
  gvzAsOf: "2026-08-01T07:00:00Z",
  netSpecAsOf: "2026-07-28T00:00:00Z",
};

const SERIES: PricePoint[] = [
  { ts: "2026-07-31T08:00:00Z", value: 3310.5 },
  { ts: "2026-08-01T08:00:00Z", value: 3325 },
];

const render = (tech: GoldTechnicals) =>
  renderToStaticMarkup(<TechnicalPanel tech={tech} series={[]} now={NOW} messages={messages} />);

const renderWithSeries = (tech: GoldTechnicals, series = SERIES) =>
  renderToStaticMarkup(<TechnicalPanel tech={tech} series={series} now={NOW} messages={messages} />);

describe("TechnicalPanel", () => {
  it("renders the regime and indicator readout when data is present", () => {
    const html = render(full);
    expect(html).toContain("above 50DMA, below 200DMA");
    expect(html).toContain("RSI14");
    expect(html).toContain("200DMA");
  });

  it("shows 'no price data yet' and no ladder when spot is null", () => {
    const html = render({ ...full, spot: null });
    expect(html).toContain("no price data yet");
    expect(html).not.toContain("200DMA");
  });

  it("shows 'insufficient data' when the regime could not be derived", () => {
    const html = render({ ...full, regime: null });
    expect(html).toContain("insufficient data");
  });

  it("warns when the technicals feed is stale", () => {
    const html = render({ ...full, stale: true });
    expect(html).toContain("stale");
  });

  it("stays silent about staleness when the feed is fresh", () => {
    expect(render(full)).not.toContain("stale");
  });

  it("never renders a buy/sell verdict", () => {
    // config/sources.yaml: technicals annotate the macro read, they must not
    // originate calls. No wording here may read as an instruction.
    const html = render(full).toLowerCase();
    for (const word of ["strong buy", "strong sell", "recommend", "signal", "target"]) {
      expect(html).not.toContain(word);
    }
  });

  // Guard audit: every fixture above uses a positive delta24h, so these
  // branches are unreached by the tests the brief specifies. See task-7-report.md.

  it("states a missing 24h reference rather than rendering it as zero", () => {
    const html = render({ ...full, spot: { ...full.spot!, delta24h: null, pct24h: null } });
    expect(html).toContain("24h —");
    expect(html).not.toContain("▲");
    expect(html).not.toContain("▼");
  });

  it("renders an exactly-flat 24h as neither a rise nor a fall", () => {
    const html = render({ ...full, spot: { ...full.spot!, delta24h: 0, pct24h: 0 } });
    expect(html).not.toContain("▲");
    expect(html).not.toContain("▼");
  });

  it("renders a fall with the down marker", () => {
    const html = render({ ...full, spot: { ...full.spot!, delta24h: -14.5, pct24h: -0.44 } });
    expect(html).toContain("▼");
    expect(html).not.toContain("▲");
  });

  it("renders a rise with the up marker", () => {
    expect(render(full)).toContain("▲");
  });

  it("omits the percent parenthetical when pct24h is unknown", () => {
    const html = render({ ...full, spot: { ...full.spot!, pct24h: null } });
    // "%)"' rather than a bare "%": the gauge row legitimately prints
    // percent-shaped copy now (ATR's "x% of spot"), so the assertion pins
    // the parenthetical itself — the exact shape "(0.44%)" takes.
    expect(html).not.toContain("%)");
    expect(html).toContain("14.5"); // the absolute delta still renders
  });

  it("omits the indicators-age line when indicatorsAsOf is null", () => {
    const html = render({ ...full, indicatorsAsOf: null });
    expect(html).not.toContain("indicators");
  });

  // `stale` covers the six TradingView series only, and those carry fetch
  // timestamps while GC carries the market bar timestamp — so the TradingView
  // set keeps ticking over exactly when the spot feed freezes. Without this
  // age, nothing on the panel can say the price itself is old, and a Yahoo
  // outage (which has happened: see the stooq -> Yahoo switch in
  // config/sources.yaml) would present a days-old price as current fact.
  it("renders the age of the spot quote", () => {
    // spot.ts 08:00Z against NOW 12:00Z. The indicator line reads "6h ago",
    // so this string belongs to the spot quote alone.
    expect(render(full)).toContain("4h ago");
  });


  // --- the live/stored split (TradingView widget beside Jamasp's reading) ---
  //
  // The panel's big figure used to be unlabelled, and `prices.GC` carries the
  // market bar timestamp — so a frozen feed printed a day-old number in the
  // typography of a live quote. The number is now explicitly Jamasp's, with
  // its provenance and age, and the live half comes from TradingView.

  it("labels the stored figure as Jamasp's own reading, with provenance", () => {
    const html = render(full);
    expect(html).toContain("Jamasp");
    expect(html).toContain("last reading");
    expect(html).toContain("GC=F");           // which feed the number came from
    expect(html).toContain("3,325");          // the reading itself still renders
  });

  it("names both instruments, because they are not the same one", () => {
    // The keyless widget cannot render COMEX futures (lib/tradingview.ts), so
    // it charts spot while Jamasp reads the front-month future. A panel that
    // named only one of them would invite the reader to take the two figures
    // for the same contract, and read the carry basis as drift.
    const html = render(full);
    expect(html).toContain("spot XAU/USD");          // what the widget shows
    expect(html).toContain("COMEX front-month");     // what the reading is
    expect(html).toContain("carry premium");         // why they differ
  });

  it("still offers the live chart when Jamasp has no price at all", () => {
    // A dead price feed is exactly when the desk most needs a live number to
    // check against, so the widget must not sit inside the spot guard.
    const html = render({ ...full, spot: null });
    expect(html).toContain("no price data yet");
    expect(html).toContain("spot XAU/USD");
  });

  it("server-renders Jamasp's own chart as the widget's fallback", () => {
    // Hydration on this deployment has failed outright before (see
    // components/spot-chart.tsx); the fallback is what the SERVER draws, so
    // a blocked or unloadable widget degrades to a real chart, never a hole.
    const html = renderWithSeries(full);
    expect(html).toContain('aria-label="gold futures');
    expect(html).toContain('stroke="var(--viz-spot)"');
  });

  it("keeps the value-exact table on screen alongside the live chart", () => {
    const html = renderWithSeries(full);
    expect(html).toContain("stored readings as table");
    expect(html).toContain("3,310.5");
  });

  it("says so when there is no stored series to fall back on", () => {
    expect(render(full)).toContain("no stored price history to fall back on");
  });

  it("shows the spot age even when the indicator feed reports fresh", () => {
    const html = render({ ...full, stale: false, indicatorsAsOf: "2026-08-01T11:59:00Z" });
    expect(html).toContain("1m ago");   // indicators, freshly fetched
    expect(html).toContain("4h ago");   // spot, four hours behind them
  });
});

/**
 * The Persian path through REGIME_KEY, which had no test at all.
 *
 * `regime` is the only prose string this panel renders (a reading, not an
 * identifier), so it gets a full Persian rendering rather than staying
 * Latin — via an exact-match lookup on deriveRegime's own return value.
 * That makes the mapping silently breakable from either end: reword
 * deriveRegime, or mistype a key here, and regimeLabel quietly falls back
 * to the raw English string with nothing failing.
 */
describe("TechnicalPanel — regime in Persian", () => {
  const faMessages = getMessages("fa");
  const renderFa = (regime: string) => renderToStaticMarkup(
    <TechnicalPanel tech={{ ...full, regime }} series={[]} now={NOW} messages={faMessages} />);

  const CASES = [
    ["above both", "tech.regimeAboveBoth"],
    ["below both", "tech.regimeBelowBoth"],
    ["above 50DMA, below 200DMA", "tech.regimeAbove50Below200"],
    ["below 50DMA, above 200DMA", "tech.regimeBelow50Above200"],
  ] as const;

  for (const [regime, key] of CASES) {
    it(`renders "${regime}" through the dictionary`, () => {
      const html = renderFa(regime);
      expect(html).toContain(fa[key]);
      // The raw English shape must not survive alongside it. "above both" is
      // not a substring of any other regime string, so this is an exact check.
      expect(html).not.toContain(`>${regime}<`);
    });
  }

  /**
   * The guard that makes the four cases above meaningful: they are hand-typed
   * literals, so on their own they only prove the dictionary agrees with the
   * TEST. This drives the real producer across every spot/SMA arrangement and
   * asserts each string it emits is one REGIME_KEY covers — so rewording
   * deriveRegime fails here rather than degrading to English on the panel.
   */
  it("covers every regime deriveRegime can actually produce", () => {
    const q = (value: number) => ({ value, ts: "2026-08-01T08:00:00Z" });
    const base = {
      spot24hAgo: null, pivotS1: null, pivotR1: null,
      rsi14: null, atr14: null, gvz: null, netSpec: null,
    };
    // spot vs (sma50, sma200): above/above, below/below, above/below, below/above
    const arrangements = [
      [3500, 3250, 3400], [3100, 3250, 3400], [3300, 3250, 3400], [3300, 3400, 3250],
    ] as const;

    const produced = new Set<string>();
    for (const [spot, sma50, sma200] of arrangements) {
      const tech = deriveTechnicals(
        { ...base, spot: q(spot), sma50: q(sma50), sma200: q(sma200) }, NOW);
      expect(tech.regime).not.toBeNull();
      produced.add(tech.regime!);
    }

    expect(produced.size).toBe(CASES.length);
    for (const regime of produced) {
      expect(CASES.map(c => c[0])).toContain(regime);
      // ...and it actually reaches the screen in Persian.
      expect(renderFa(regime)).toContain(
        fa[CASES.find(c => c[0] === regime)![1]]);
    }
  });
});
