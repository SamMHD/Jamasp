import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketMap } from "../components/market-map";
import {
  LABEL_FONT, LABEL_PAD, LINE_RATIO, MAX_TIER, META_BAND, MIN_LABEL_H,
  PIP_BAND, PIP_MIN_W, POST_TIER_MIN, ROLLUP_TIER_MIN,
  charAdvance, fitLabel, importanceInsets, metaTextFor, tierFate,
  type ImportanceTreatment,
} from "../components/map-tiles";
import type { ScoredItem } from "../lib/marketmap";

/**
 * The importance channel is a THIRD encoding on a map that already carries
 * two, which is where treemaps usually go wrong. These tests pin the three
 * things that make it survivable:
 *
 *   1. it is off unless asked for, so nothing that does not opt in changes;
 *   2. the mark reports `tier` and nothing else, at fixed geometry, so it
 *      reads the same on a 60px tile and a 400px one;
 *   3. the band it reserves comes OUT of the label box before the label is
 *      sized, so the zero-overflow guarantee still holds by construction.
 */

/** Ascent + descent in Inter — what a line of type actually inks. Same
 *  constant test/map-label-fit.test.ts measures with, and for the same
 *  reason: charging only the font size is what put descenders through the
 *  bottom edge of the largest tiles. */
const PAINTED_LINE = 1.22;

function item(over: Partial<ScoredItem> = {}): ScoredItem {
  return {
    itemId: "a", tier: 4, direction: 2, conviction: 0.8, theme: "rates_dollar",
    headline: "Gold jumps as Treasury buyback plans push yields lower",
    source: "investing_commodities", url: "https://x/1",
    publishedAt: "2026-08-19T18:46:13Z", ...over,
  };
}

const render = (items: ScoredItem[], importance: ImportanceTreatment) =>
  renderToStaticMarkup(
    <MarketMap items={items} width={800} height={500} range="24h"
      coverage={{ scored: items.length, unscored: 0 }} importance={importance} />);

describe("tierFate", () => {
  it("splits on the news pipeline's own gates", () => {
    expect(tierFate(5)).toBe("posted");
    expect(tierFate(POST_TIER_MIN)).toBe("posted");
    expect(tierFate(POST_TIER_MIN - 1)).toBe("held");
    expect(tierFate(ROLLUP_TIER_MIN)).toBe("held");
    expect(tierFate(ROLLUP_TIER_MIN - 1)).toBe("quiet");
    expect(tierFate(1)).toBe("quiet");
  });

  it("honours gates passed in, so config/settings.yaml stays the authority", () => {
    // The constants mirror config/settings.yaml. A caller with loadSettings()
    // to hand must be able to override them, or a threshold change on the
    // host silently mislabels every tile.
    expect(tierFate(3, { post: 3, rollup: 2 })).toBe("posted");
    expect(tierFate(2, { post: 3, rollup: 2 })).toBe("held");
  });
});

describe("metaTextFor", () => {
  it("names the tier and what the channel did with it", () => {
    expect(metaTextFor(5)).toBe("T5 · POSTED");
    expect(metaTextFor(3)).toBe("T3 · HELD");
    expect(metaTextFor(1)).toBe("T1 · QUIET");
  });
});

describe("MarketMap importance channel", () => {
  it("draws nothing new by default", () => {
    // The whole point of an opt-in third channel: a caller that does not ask
    // for it must get the map exactly as it shipped.
    const before = renderToStaticMarkup(
      <MarketMap items={[item()]} width={800} height={500} range="24h"
        coverage={{ scored: 1, unscored: 0 }} />);
    expect(before).toBe(render([item()], "none"));
    expect(before).not.toContain("POSTED");
  });

  it("draws the full run of pips, with `tier` of them filled", () => {
    // Every pip is drawn, not just the filled ones — without the run's full
    // length there is no denominator and "three marks" stops meaning
    // "three out of five".
    const html = render([item({ tier: 3 })], "pips");
    const filled = html.match(/fill-opacity="0\.95"/g) ?? [];
    const empty = html.match(/fill-opacity="0\.22"/g) ?? [];
    expect(filled).toHaveLength(3);
    expect(empty).toHaveLength(MAX_TIER - 3);
  });

  it("sizes the pips independently of the tile, so tiles compare", () => {
    // A bar measured as a fraction of its own tile's width makes a tier-4 on
    // a wide tile out-run a tier-5 on a narrow one — the reader compares
    // lengths and gets the answer backwards. Pip width must not move with
    // the tile, so the same tier renders identical geometry at both sizes.
    const wide = renderToStaticMarkup(
      <MarketMap items={[item({ tier: 4 })]} width={1200} height={600} range="24h"
        coverage={{ scored: 1, unscored: 0 }} importance="pips" />);
    const narrow = renderToStaticMarkup(
      <MarketMap items={[item({ tier: 4 })]} width={300} height={600} range="24h"
        coverage={{ scored: 1, unscored: 0 }} importance="pips" />);
    const widths = (h: string) =>
      [...h.matchAll(/<rect[^>]*height="3"[^>]*width="(\d+)"/g)].map(m => m[1]);
    const alt = (h: string) =>
      [...h.matchAll(/<rect[^>]*width="(\d+)"[^>]*height="3"/g)].map(m => m[1]);
    const wideW = [...widths(wide), ...alt(wide)];
    const narrowW = [...widths(narrow), ...alt(narrow)];
    expect(wideW).toHaveLength(MAX_TIER);
    expect(wideW).toEqual(narrowW);
  });

  it("strokes the publish gate: solid posted, dashed held, nothing below", () => {
    const posted = render([item({ tier: 5 })], "boundary");
    expect(posted).toContain('stroke-opacity="0.9"');
    expect(posted).not.toContain('stroke-dasharray="4 3"');

    const held = render([item({ tier: ROLLUP_TIER_MIN })], "boundary");
    expect(held).toContain('stroke-dasharray="4 3"');

    // Below the rollup gate the story never reached the channel, and the map
    // says so by adding no mark at all — an "absent" state, not a third
    // stroke competing with the other two.
    const quiet = render([item({ tier: 1 })], "boundary");
    expect(quiet).not.toContain('stroke-opacity="0.9"');
    expect(quiet).not.toContain('stroke-dasharray="4 3"');
  });

  it("reads the tier out in words on tiles with room for it", () => {
    expect(render([item({ tier: 5 })], "meta")).toContain("T5 · POSTED");
    expect(render([item({ tier: 3 })], "meta")).toContain("T3 · HELD");
    expect(render([item({ tier: 2 })], "meta")).toContain("T2 · QUIET");
  });

  it("names the channel in the legend rather than leaving it unexplained", () => {
    // A third channel nobody can name is decoration, not a channel.
    expect(render([item()], "pips")).toContain("filled pips");
    expect(render([item()], "boundary")).toContain("posted now");
    expect(render([item()], "meta")).toContain("what the news channel did");
    expect(render([item()], "none")).not.toContain("filled pips");
  });

  it("says on every tile's hover title what the channel did with it", () => {
    expect(render([item({ tier: 5 })], "none"))
      .toContain("tier 5 (posted to the channel)");
    expect(render([item({ tier: 3 })], "none"))
      .toContain("tier 3 (held for the rollup)");
  });
});

describe("importanceInsets", () => {
  it("reserves nothing for treatments that paint inside the tile", () => {
    expect(importanceInsets("none", 400, 300)).toEqual({ top: 0, bottom: 0 });
    expect(importanceInsets("boundary", 400, 300)).toEqual({ top: 0, bottom: 0 });
  });

  it("reserves a band only when the mark actually fits", () => {
    expect(importanceInsets("pips", 400, 300)).toEqual({ top: PIP_BAND, bottom: 0 });
    // Too narrow for the full run: a clipped run reads as a lower tier, so
    // the mark is dropped and its band is given back to the label.
    expect(importanceInsets("pips", PIP_MIN_W - 1, 300)).toEqual({ top: 0, bottom: 0 });
    expect(importanceInsets("pips", 400, 8)).toEqual({ top: 0, bottom: 0 });

    expect(importanceInsets("meta", 400, 300)).toEqual({ top: 0, bottom: META_BAND });
    expect(importanceInsets("meta", 400, META_BAND + MIN_LABEL_H - 1))
      .toEqual({ top: 0, bottom: 0 });
  });
});

describe("labels stay inside the box a treatment leaves them", () => {
  /**
   * The same containment invariant test/map-label-fit.test.ts holds the plain
   * map to, re-derived against the REDUCED box. This is the failure a
   * reserved band introduces if the caller sizes the label to the whole tile
   * and then slides it: the text clears the top and falls out the bottom.
   */
  const paintedWidth = (lines: string[], f: number) =>
    Math.max(...lines.map(l => l.length)) * f * charAdvance(f);
  const paintedHeight = (lines: string[], f: number) =>
    f * PAINTED_LINE + (lines.length - 1) * f * LINE_RATIO;

  const SIZES: [number, number][] = [
    [400, 300], [220, 160], [120, 90], [60, 40], [50, 20], [46, 19],
  ];
  const TEXT = "Gold jumps as Treasury buyback plans push yields lower";

  it.each<ImportanceTreatment>(["none", "pips", "boundary", "meta"])(
    "%s keeps every label inside its own reduced box", treatment => {
      for (const [w, h] of SIZES) {
        const inset = importanceInsets(treatment, w, h);
        const boxH = h - inset.top - inset.bottom;
        const { fontSize, lines } = fitLabel(TEXT, w, boxH);
        if (!lines.length) continue;
        expect(paintedWidth(lines, fontSize),
          `${treatment} ${w}x${h} width`).toBeLessThanOrEqual(w - LABEL_PAD);
        expect(paintedHeight(lines, fontSize),
          `${treatment} ${w}x${h} height`).toBeLessThanOrEqual(boxH);
        if (fontSize > LABEL_FONT) {
          expect(paintedHeight(lines, fontSize),
            `${treatment} ${w}x${h} padded height`)
            .toBeLessThanOrEqual(boxH - LABEL_PAD * 2);
        }
      }
    });
});
