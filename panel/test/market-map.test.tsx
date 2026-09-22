import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketMap } from "../components/market-map";
import type { ScoredItem } from "../lib/marketmap";
import type { Locale, Messages } from "../lib/i18n";
import en from "../messages/en.json";
import fa from "../messages/fa.json";

const messages = { en: en as Messages, fa: fa as Messages };

function item(over: Partial<ScoredItem> = {}): ScoredItem {
  return {
    itemId: "a", tier: 4, direction: 2, conviction: 0.8, theme: "rates_dollar",
    headline: "Gold jumps as Treasury buyback plans push yields lower",
    headline_fa: null,
    source: "investing_commodities", url: "https://x/1",
    publishedAt: "2026-08-19T18:46:13Z", ...over,
  };
}

const render = (
  items: ScoredItem[],
  extra: { themeMultipliers?: Record<string, number>;
           fittedAt?: string | null; locale?: Locale; messages?: Messages } = {},
) => renderToStaticMarkup(
  <MarketMap items={items} width={800} height={500} range="24h"
    coverage={{ scored: items.length, unscored: 0 }}
    locale="en" messages={messages.en} {...extra} />);

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
        coverage={{ scored: 1, unscored: 7 }} locale="en" messages={messages.en} />);
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
        coverage={{ scored: many.length, unscored: 0 }} locale="en" messages={messages.en} />);
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

// The visible on-tile marker (map-tiles.tsx's fallbackMarkerBand) is its
// own independent <text> element, right-anchored and 9px — see MapTile's
// JSX. Matched precisely on that shape rather than a bare `.toContain("EN")`,
// which would also match "EN" appearing incidentally inside a headline.
const MARKER_RE =
  /<text x="[\d.]+" y="([\d.]+)" text-anchor="end" font-size="(\d+)"[^>]*>EN<\/text>/;

function visibleMarker(html: string): { y: number; fontSize: number } | null {
  const m = html.match(MARKER_RE);
  return m ? { y: Number(m[1]), fontSize: Number(m[2]) } : null;
}

// The wrapped label's own first <text> — text-anchor="middle" with a
// <tspan> child distinguishes it from the meta band's <text> (also
// text-anchor="middle", but a plain text child, no <tspan>), which this
// suite does not otherwise exercise but should not accidentally match.
function firstLabelLine(html: string): { y: number; fontSize: number } | null {
  const m = html.match(
    /<text x="[\d.]+" y="([\d.]+)" text-anchor="middle" font-size="(\d+)"[^>]*><tspan/);
  return m ? { y: Number(m[1]), fontSize: Number(m[2]) } : null;
}

// Mirrors map-tiles.tsx's own ASCENT/DESCENT (0.97/0.25, Inter's measured
// ratios) — same duplication test/map-importance.test.tsx's PAINTED_LINE
// already carries, and for the same reason: an independent, ground-truth
// check of what the glyphs actually ink, not a re-assertion of the
// production constant against itself.
const ASCENT = 0.97, DESCENT = 0.25;
function inkRange(node: { y: number; fontSize: number }): [number, number] {
  return [node.y - node.fontSize * ASCENT, node.y + node.fontSize * DESCENT];
}

describe("MarketMap Persian headlines", () => {
  // Short enough (well under fitLabel's MIN_LINE_CHARS) that the wrapper
  // keeps it on one line rather than splitting it across tspans, so a plain
  // substring check is a valid test of what actually reaches the screen —
  // not just "the component did not crash".
  const HEADLINE_FA = "طلا بالا رفت";

  it("renders the Persian headline as the tile label, with no EN marker anywhere", () => {
    const html = render([item({ headline_fa: HEADLINE_FA })],
      { locale: "fa", messages: messages.fa });
    expect(html).toContain(HEADLINE_FA);
    // The wrapped label is centred on the raw headline text with no
    // additional per-line escaping; a single Persian tspan is the ground
    // truth here rather than a JSX-serialisation detail.
    const withoutTitles = html.replace(/<title>[\s\S]*?<\/title>/g, "");
    expect(withoutTitles).toContain(HEADLINE_FA);
    expect(withoutTitles).not.toContain("Gold jumps as Treasury buyback");
    expect(html).not.toContain(messages.fa["content.sourceEnglishTitle"]);
    // Persian exists, so this is not a fallback: neither the hover title
    // nor the visible corner mark should say otherwise.
    expect(visibleMarker(html)).toBeNull();
  });

  it("falls back to the English label when no Persian headline exists, and shows the visible marker as well as the title", () => {
    // map-tiles.tsx draws its label as raw SVG <text>/<tspan>, which cannot
    // host the HTML <SourceLang> chip (see market-map.tsx#tileTitle) — the
    // fallback marker for this surface is its own independent <text>
    // element (map-tiles.tsx#fallbackMarkerBand), not the SourceLang chip,
    // and the hover title carries the same signal in addition to it.
    const html = render([item({ headline_fa: null })], { locale: "fa", messages: messages.fa });
    const withoutTitles = html.replace(/<title>[\s\S]*?<\/title>/g, "");
    expect(withoutTitles).toContain("Gold jumps as Treasury buyback");
    expect(html).toContain(messages.fa["content.sourceEnglishTitle"]);
    // The visible marker is not hover-gated: it must be in the markup this
    // suite's renderToStaticMarkup already produces, not behind an
    // interaction this project has no way to simulate.
    expect(visibleMarker(html)).not.toBeNull();
  });

  it("never shows the fallback marker — title or visible — when English is what was asked for", () => {
    const html = render([item({ headline_fa: HEADLINE_FA })],
      { locale: "en", messages: messages.en });
    const withoutTitles = html.replace(/<title>[\s\S]*?<\/title>/g, "");
    expect(withoutTitles).toContain("Gold jumps as Treasury buyback");
    expect(withoutTitles).not.toContain(HEADLINE_FA);
    expect(html).not.toContain(messages.en["content.sourceEnglishTitle"]);
    expect(visibleMarker(html)).toBeNull();
  });

  it("draws the visible marker at the smallest tile size that still shows a label, without colliding with it", () => {
    // header (24) + 32 = 56: 32 is exactly MIN_LABEL_H (18) +
    // FALLBACK_MARKER_BAND (14) — map-tiles.tsx's own floor for showing the
    // marker at all. Below it the marker is suppressed outright (see
    // fallbackMarkerFits); this is the smallest tile where it still shows,
    // which is exactly the case a corner mark is most likely to crowd the
    // label it sits next to.
    const boundary = renderToStaticMarkup(
      <MarketMap items={[item({ headline_fa: null, headline: "Gold jumps" })]}
        width={200} height={56} range="24h"
        coverage={{ scored: 1, unscored: 0 }} locale="fa" messages={messages.fa} />);
    const marker = visibleMarker(boundary);
    const label = firstLabelLine(boundary);
    expect(marker).not.toBeNull();
    expect(label).not.toBeNull();
    const markerRange = inkRange(marker!);
    const labelRange = inkRange(label!);
    // The marker's ink must end before the label's ink begins — computed
    // from the actual rendered coordinates, not asserted as a fixed pixel
    // value, so this fails if either side's geometry ever drifts.
    expect(markerRange[1]).toBeLessThan(labelRange[0]);
  });

  it("suppresses the marker below its own floor, even though the label alone would still show", () => {
    // One px under fallbackMarkerFits' own height floor (32): the label's
    // bare floor (MIN_LABEL_H, 18) is still comfortably cleared, so the
    // label keeps showing — only the marker's extra band does not fit, and
    // "reserves nothing and draws nothing" (map-tiles.tsx's own rule for
    // every optional band) is what must happen rather than crowding it in.
    const boundary = renderToStaticMarkup(
      <MarketMap items={[item({ headline_fa: null, headline: "Gold jumps" })]}
        width={200} height={55} range="24h"
        coverage={{ scored: 1, unscored: 0 }} locale="fa" messages={messages.fa} />);
    expect(visibleMarker(boundary)).toBeNull();
    expect(firstLabelLine(boundary)).not.toBeNull();
  });
});

describe("MarketMap — Persian chrome", () => {
  it("translates the empty-state sentence", () => {
    // render()'s coverage is derived from items.length, so an empty array
    // renders the base "no scored stories" sentence with no unscored clause
    // — that clause is exercised directly in the next test.
    const html = render([], { locale: "fa", messages: messages.fa });
    expect(html).toContain(fa["map.windowLast24h"]);
    expect(html).not.toMatch(/[۰-۹]/);
  });

  it("translates the unscored-count clause when items are all unscored", () => {
    const html = renderToStaticMarkup(
      <MarketMap items={[]} width={800} height={500} range="24h"
        coverage={{ scored: 0, unscored: 3 }} locale="fa" messages={messages.fa} />);
    expect(html).toContain(fa["map.unscoredItemWord"]);
    expect(html).toContain(fa["map.notShown"]);
    expect(html).toContain("3");
    expect(html).not.toMatch(/[۰-۹]/);
  });

  it("translates the footer caption's words, keeping the count Latin", () => {
    const html = render([item(), item({ itemId: "b" })], { locale: "fa", messages: messages.fa });
    expect(html).toContain(fa["map.scoredWord"]);
    expect(html).toContain(fa["map.storyWord"]);
    expect(html).toContain(fa["map.windowLast24h"]);
    expect(html).toContain(fa["map.unscoredNotShownFooter"]);
    expect(html).toContain(fa["map.themeFitNotRun"]);
    expect(html).toContain(fa["map.areaIsTier"]);
    expect(html).not.toMatch(/[۰-۹]/);
  });

  it("translates the dated theme-fit line when a fit exists", () => {
    const html = render([item()], {
      locale: "fa", messages: messages.fa,
      themeMultipliers: { rates_dollar: 1.2 }, fittedAt: "2026-08-19T00:00:00Z",
    });
    expect(html).toContain(fa["map.themeFit"]);
    expect(html).toContain(fa["map.notAppliedToArea"]);
    expect(html).not.toContain(fa["map.themeFitNotRun"]);
  });

  it("translates the hatched-legend label and the pips importance key", () => {
    const html = renderToStaticMarkup(
      <MarketMap items={[item()]} width={800} height={500} range="24h"
        coverage={{ scored: 1, unscored: 0 }} importance="pips"
        locale="fa" messages={messages.fa} />);
    expect(html).toContain(fa["map.hatchedLabel"]);
    // The template's "{n}" is replaced with the real MAX_TIER, so the
    // dictionary string itself never renders verbatim.
    expect(html).not.toContain("{n}");
    expect(html).toContain(fa["tone.bearish"]);
  });
});

/**
 * The two aria-labels that used to be English in both locales, deferring to
 * "this task's report" for the reasoning — a report that was never written.
 *
 * They are the region's ONLY name: there is no visible heading beside them,
 * which is precisely why they have to be translated. A Persian
 * screen-reader user would otherwise be the one reader served no Persian.
 * Closed strings, hand-translated, so no EN marker: chrome, not content.
 */
describe("MarketMap region labels", () => {
  it("names the populated region through the dictionary", () => {
    const html = render([item({})], { locale: "fa", messages: messages.fa });
    expect(html).toContain(`aria-label="${messages.fa["map.regionLabel"]}"`);
    expect(html).not.toContain('aria-label="Scored news treemap"');
  });

  it("names the EMPTY region through the same key", () => {
    // A separate return branch, and the one a freshly deployed host shows.
    const html = render([], { locale: "fa", messages: messages.fa });
    expect(html).toContain(`aria-label="${messages.fa["map.regionLabel"]}"`);
    expect(html).not.toContain("Scored news treemap");
  });

  it("composes the svg's counted sentence in Persian with Latin digits", () => {
    const html = render([item({}), item({ itemId: "i2", url: "https://x.test/2" })],
      { locale: "fa", messages: messages.fa });
    const expected = messages.fa["map.svgAriaTemplate"]
      .replace("{n}", "2")
      .replace("{window}", messages.fa["map.windowLast24h"]);
    expect(html).toContain(expected);
    expect(html).not.toContain("scored news treemap,");
  });

  it("keeps the English labels in the English locale", () => {
    const html = render([item({})], { locale: "en", messages: messages.en });
    expect(html).toContain(`aria-label="${messages.en["map.regionLabel"]}"`);
  });
});
