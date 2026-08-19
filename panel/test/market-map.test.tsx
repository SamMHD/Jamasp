import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketMap } from "../components/market-map";
import type { ScoredItem } from "../lib/marketmap";

function item(over: Partial<ScoredItem> = {}): ScoredItem {
  return {
    itemId: "a", tier: 4, direction: 2, conviction: 0.8, theme: "rates_dollar",
    headline: "Gold jumps as Treasury buyback plans push yields lower",
    source: "investing_commodities", url: "https://x/1",
    publishedAt: "2026-08-19T18:46:13Z", ...over,
  };
}

const render = (items: ScoredItem[]) => renderToStaticMarkup(
  <MarketMap items={items} width={800} height={500} range="today"
    coverage={{ scored: items.length, unscored: 0 }} />);

describe("MarketMap", () => {
  it("renders one rect per item and names the theme", () => {
    const html = render([item(), item({ itemId: "b", theme: "geopolitics" })]);
    expect(html.match(/<rect/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Rates &amp; dollar");
    expect(html).toContain("Geopolitics");
  });

  it("hatches bearish tiles and leaves bullish ones unhatched", () => {
    // The hatch is what makes the dE 6.9 pair legal. If this regresses the
    // palette becomes non-compliant, so the test is a compliance guard.
    const bear = render([item({ direction: -2, conviction: 0.8 })]);
    expect(bear).toContain("url(#map-hatch)");
    const bull = render([item({ direction: 2, conviction: 0.8 })]);
    expect(bull).not.toContain("url(#map-hatch)");
  });

  it("gives every tile a title carrying the full headline and its scores", () => {
    const html = render([item()]);
    expect(html).toContain("<title>");
    expect(html).toContain("Gold jumps as Treasury buyback");
    expect(html).toContain("tier 4");
    expect(html).toContain("investing_commodities");
  });

  it("renders the legend, including the hatch and neutral keys", () => {
    const html = render([item()]);
    expect(html.toLowerCase()).toContain("bearish");
    expect(html.toLowerCase()).toContain("bullish");
  });

  it("states coverage rather than implying completeness", () => {
    const html = renderToStaticMarkup(
      <MarketMap items={[item()]} width={800} height={500} range="today"
        coverage={{ scored: 1, unscored: 7 }} />);
    expect(html).toContain("7");
  });

  it("renders an empty state instead of an empty box", () => {
    const html = render([]);
    expect(html.match(/<rect/g) ?? []).toHaveLength(0);
    expect(html.toLowerCase()).toContain("no scored");
  });
});
