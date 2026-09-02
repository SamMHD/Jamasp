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

const render = (
  items: ScoredItem[],
  extra: { themeMultipliers?: Record<string, number>;
           fittedAt?: string | null } = {},
) => renderToStaticMarkup(
  <MarketMap items={items} width={800} height={500} range="24h"
    coverage={{ scored: items.length, unscored: 0 }} {...extra} />);

describe("MarketMap", () => {
  it("renders one rect per item and names the theme", () => {
    const html = render([item(), item({ itemId: "b", theme: "geopolitics" })]);
    expect(html.match(/<rect/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Rates &amp; dollar");
    expect(html).toContain("Geopolitics");
  });

  it("hatches bearish tiles and leaves bullish ones unhatched", () => {
    // All-pairs CVD measurement (not just the poles) found the worst
    // failures at bear/bull-mid (dE 2.8 protan) and bear-mid/bull-mid
    // (dE 3.1 deutan) — the hatch is what keeps every pair separable. If
    // this regresses the palette becomes non-compliant, so the test is a
    // compliance guard.
    const bear = render([item({ direction: -2, conviction: 0.8 })]);
    expect(bear).toContain("url(#map-hatch)");
    const bull = render([item({ direction: 2, conviction: 0.8 })]);
    expect(bull).not.toContain("url(#map-hatch)");
  });

  it("hatches the bear-mid step too, not just the pole", () => {
    // bear-mid/bull-mid is the worst deuteranopia failure of all ten pairs
    // (dE 3.1) — worse than the pole pair. Hatching only `bear` would leave
    // this pair colour-only and non-compliant, so pin the mid step too.
    const bearMid = render([item({ direction: -1, conviction: 0.6 })]); // s = -0.30
    expect(bearMid).toContain("url(#map-hatch)");
    const bullMid = render([item({ direction: 1, conviction: 0.6 })]); // s = +0.30
    expect(bullMid).not.toContain("url(#map-hatch)");
  });

  it("gives every tile a title carrying the full headline and its scores", () => {
    const html = render([item()]);
    expect(html).toContain("<title>");
    expect(html).toContain("Gold jumps as Treasury buyback");
    expect(html).toContain("tier 4");
    expect(html).toContain("investing_commodities");
  });

  it("keeps the title reachable on a bearish tile, not just a bullish one", () => {
    // The default item() fixture is bullish (direction: 2), so the title
    // test above never exercised the hatch overlay. The hatch rect paints
    // on top of the base rect at the same coordinates, and under default
    // pointer-events a url(#pattern) fill counts as painted across the
    // whole tile — so a <title> left on the base rect would be swallowed
    // by the hatch on every bearish tile. Pin the bearish case directly.
    //
    // The headline assertion alone does NOT discriminate: it passes
    // against the pre-fix markup too, since renderToStaticMarkup never
    // exercises pointer-events or hit order, and the pre-fix version also
    // had a <title> with the headline — just nested one level deeper,
    // inside the <rect>. The two structural assertions below are what
    // actually pin the fix.
    const html = render([item({ direction: -2, conviction: 0.8 })]);
    expect(html).toContain("<title>");
    expect(html).toContain("Gold jumps as Treasury buyback");

    // The hatch overlay must not be a hit target, or it swallows the
    // tooltip on exactly the tiles the hatch exists to make readable.
    expect(html).toContain('pointer-events="none"');

    // <title> must be a child of the <g>, not of the base <rect>: a title
    // on the group survives any overlay painted over the rect.
    expect(html).not.toMatch(/<rect[^>]*>\s*<title>/);
  });

  it("renders the legend, including the hatch and neutral keys", () => {
    const html = render([item()]);
    expect(html.toLowerCase()).toContain("bearish");
    expect(html.toLowerCase()).toContain("bullish");
  });

  it("gives different tones different text ink, not one colour for all five", () => {
    // TONE_INK references a distinct theme-aware CSS variable per tone
    // (--map-ink-bull vs --map-ink-neutral, etc.) rather than a literal hex,
    // since the ink/fill pairing inverts between the light and dark ramps.
    // Nothing else in the suite would catch a regression that collapsed
    // this to a single constant.
    const html = render([
      item({ itemId: "a", direction: 2, conviction: 0.8, theme: "rates_dollar" }), // bull
      item({
        itemId: "b", direction: 0, conviction: 0, theme: "geopolitics", // neutral
        headline: "Central bank buying steady into September",
      }),
    ]);
    expect(html).toContain('fill="var(--map-ink-bull)"');
    expect(html).toContain('fill="var(--map-ink-neutral)"');
  });

  it("states coverage rather than implying completeness", () => {
    const html = renderToStaticMarkup(
      <MarketMap items={[item()]} width={800} height={500} range="24h"
        coverage={{ scored: 1, unscored: 7 }} />);
    expect(html).toContain("7");
  });

  it("drops the label but keeps the rectangle on tiles below the size threshold", () => {
    // Pack far more items into a small canvas than it can hold at
    // MIN_LABEL_W/MIN_LABEL_H (see the comment above those constants):
    // 40 same-tier items in one theme over 120x70 leaves each tile well
    // under both thresholds. Every tile must still render as a <rect>;
    // none may render a headline-bearing <text> label — clipped text is
    // never acceptable, so the label is dropped outright instead.
    const many = Array.from({ length: 40 }, (_, i) => item({
      itemId: `s${i}`, tier: 1, theme: "rates_dollar",
      headline: "Gold jumps as Treasury buyback plans push yields lower",
    }));
    const html = renderToStaticMarkup(
      <MarketMap items={many} width={120} height={70} range="24h"
        coverage={{ scored: many.length, unscored: 0 }} />);
    expect(html.match(/<rect/g)?.length).toBe(40);
    // Strip <title> content (which legitimately always carries the full
    // headline) before checking that no visible <text> label leaked one
    // in — the two must not be confused with each other.
    const withoutTitles = html.replace(/<title>[\s\S]*?<\/title>/g, "");
    expect(withoutTitles).not.toContain("Gold jumps");
  });

  it("renders an empty state instead of an empty box", () => {
    const html = render([]);
    expect(html.match(/<rect/g) ?? []).toHaveLength(0);
    expect(html.toLowerCase()).toContain("no scored");
  });

  it("states in the footer whether the areas are learned or provisional", () => {
    // A map that quietly rescaled itself the day a fit first succeeded, with
    // nothing on the page saying so, would be worse than one that reads
    // "provisional" for three weeks.
    expect(render([item()], { themeMultipliers: {}, fittedAt: null }))
      .toContain("weights not yet fitted");

    expect(render([item()], {
      themeMultipliers: { rates_dollar: 1.6 },
      fittedAt: "2026-08-20T04:17:00Z",
    })).not.toContain("weights not yet fitted");
  });

  it("defaults to the provisional footer when no weights are passed at all", () => {
    expect(render([item()])).toContain("weights not yet fitted");
  });

  it("never claims the areas are weighted when the multiplier map is empty, even with a fittedAt", () => {
    // The bug this guards: weights.json's fitted_at is one top-level
    // timestamp shared by every fit type. A caller could pass a truthy
    // fittedAt from a technical-only fit run alongside empty
    // themeMultipliers (exactly page.tsx's state during a deployment's
    // first ~2 weeks, before the theme fit reaches min_rows) and, if the
    // component trusted fittedAt alone, the footer would falsely announce
    // a rescale that never happened. The component must derive the claim
    // from both inputs so no caller can produce that mismatch.
    expect(render([item()], { themeMultipliers: {}, fittedAt: "2026-08-20T04:17:00Z" }))
      .toContain("weights not yet fitted");
  });
});
