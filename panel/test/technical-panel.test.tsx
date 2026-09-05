import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TechnicalPanel } from "../components/technical-panel";
import type { PricePoint } from "../lib/db";
import type { GoldTechnicals } from "../lib/technicals";

const NOW = new Date("2026-08-01T12:00:00Z");

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
  renderToStaticMarkup(<TechnicalPanel tech={tech} series={[]} now={NOW} />);

const renderWithSeries = (tech: GoldTechnicals, series = SERIES) =>
  renderToStaticMarkup(<TechnicalPanel tech={tech} series={series} now={NOW} />);

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
