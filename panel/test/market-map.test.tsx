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

  it("paints tile ink through a per-tone theme variable, never a literal", () => {
    // TONE_INK references a distinct theme-aware CSS variable per tone
    // (--map-ink-bull vs --map-ink-neutral, etc.) rather than a literal hex,
    // because the ink/fill pairing inverts between the light and dark ramps:
    // pale light fills take dark ink, dark fills take light ink. Within one
    // theme the five now resolve to the SAME value — the ramp is a single
    // lightness band on purpose, so that ink does not flip from tile to
    // neighbouring tile — but they stay five separate tokens so the palette
    // validator measures each pairing against its own fill. Nothing else in
    // the suite would catch a regression that collapsed this to one
    // hard-coded constant and silently unhooked it from the theme.
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

  it("tells the footer's reader that area is the tier, in every fit state", () => {
    // The one claim that is true whatever the fit has or has not done. It is
    // unconditional on purpose: the footer used to describe area only in the
    // fitted branch, and described it wrongly.
    const states: Parameters<typeof render>[1][] = [
      {},
      { themeMultipliers: {}, fittedAt: null },
      { themeMultipliers: { rates_dollar: 1.6 }, fittedAt: "2026-08-20T04:17:00Z" },
    ];
    // The apostrophe-free wording is deliberate: this string is asserted
    // against rendered HTML here and by getByText in the e2e smoke test, and
    // an apostrophe arrives as &#x27; in one of those and not the other.
    for (const props of states) {
      expect(render([item()], props)).toContain("area is the triage tier");
    }
  });

  it("never says area is weighted by the fit, because it is not", () => {
    // The regression this pins. Until 2026-09-06 area was
    // `tierWeight(tier) * multiplier[theme]` and the footer said so; area is
    // now tier alone, and a footer still claiming a rescale would be a lie
    // about the map's primary channel.
    const html = render([item()], {
      themeMultipliers: { rates_dollar: 1.6 },
      fittedAt: "2026-08-20T04:17:00Z",
    });
    expect(html).not.toContain("areas weighted");
    expect(html).toContain("not applied to area");
  });

  it("dates the theme fit when there is one, and says so when there is not", () => {
    expect(render([item()], { themeMultipliers: {}, fittedAt: null }))
      .toContain("theme fit not yet run");

    expect(render([item()], {
      themeMultipliers: { rates_dollar: 1.6 },
      fittedAt: "2026-08-20T04:17:00Z",
    })).not.toContain("theme fit not yet run");
  });

  it("defaults to the unfitted footer when no weights are passed at all", () => {
    expect(render([item()])).toContain("theme fit not yet run");
  });

  it("never dates a theme fit from a technical-only run's timestamp", () => {
    // The bug this guards: weights.json's fitted_at is one top-level
    // timestamp shared by every fit type. A caller could pass a truthy
    // fittedAt from a technical-only fit run alongside empty
    // themeMultipliers (exactly page.tsx's state during a deployment's
    // first ~2 weeks, before the theme fit reaches min_rows) and, if the
    // component trusted fittedAt alone, the footer would put an age on a
    // theme fit that has never run. The component must derive the claim
    // from both inputs so no caller can produce that mismatch.
    expect(render([item()], { themeMultipliers: {}, fittedAt: "2026-08-20T04:17:00Z" }))
      .toContain("theme fit not yet run");
  });
});
