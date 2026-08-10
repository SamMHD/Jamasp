import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TechnicalPanel } from "../components/technical-panel";
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
};

const render = (tech: GoldTechnicals) =>
  renderToStaticMarkup(<TechnicalPanel tech={tech} series={[]} now={NOW} />);

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

  // Guard audit: every fixture above uses a positive delta24h, so these three
  // branches are unreached by the tests the brief specifies. See task-7-report.md.

  it("shows a down arrow, not up, when the 24h move is negative", () => {
    const html = render({ ...full, spot: { ...full.spot!, delta24h: -14.5, pct24h: -0.438 } });
    expect(html).toContain("▼");
    expect(html).not.toContain("▲");
  });

  it("omits the percent parenthetical when pct24h is unknown", () => {
    const html = render({ ...full, spot: { ...full.spot!, pct24h: null } });
    expect(html).not.toContain("%");
    expect(html).toContain("14.5"); // the absolute delta still renders
  });

  it("omits the indicators-age line when indicatorsAsOf is null", () => {
    const html = render({ ...full, indicatorsAsOf: null });
    expect(html).not.toContain("indicators");
  });
});
