import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AVG_CHAR_W, MapGroupHeader, MapTile, charAdvance, trackingFor,
} from "../components/map-tiles";
import { ArcGauge } from "../components/arc-gauge";
import type { Messages } from "../lib/i18n";
import en from "../messages/en.json";
import faJson from "../messages/fa.json";

const messages = en as Messages;
const fa = faJson as unknown as Messages;

const FA = "نرخ بهره و دلار";
const FA_LINES = ["نرخ بهره و", "دلار طلا"];
const EN_LINES = ["Fed holds rates", "steady at 4.25%"];

/**
 * WebKit — every Safari, desktop and iOS — renders Arabic-script text two
 * ways this map got wrong. Both were reproduced against real WebKit and
 * confirmed absent in Chromium, which is why a green suite and a look at the
 * panel in Chrome missed them for the whole of the i18n work.
 *
 * 1. `letter-spacing` on Arabic script drops WebKit off its complex-text
 *    shaping path. Letters come out unjoined AND in reversed visual order,
 *    so "نرخ بهره و دلار" paints as "رلد و هرهب خرن" — not a subtle
 *    kerning artifact, unreadable text. It is the letter-spacing alone:
 *    it reverses under `direction: rtl` just as readily as under `ltr`.
 *
 * 2. Splitting one logical string across `<tspan>`s bleeds content between
 *    lines, so line 1 paints a fragment of line 2. The bidi property has to
 *    sit on EACH `<tspan>` — putting `direction: rtl` or
 *    `unicode-bidi: plaintext` on the parent `<text>` does not fix it,
 *    because each tspan carrying its own `x` is its own text chunk.
 *
 * `unicode-bidi: plaintext` is what goes on the tspans rather than
 * `direction: rtl`: it derives base direction per line from that line's own
 * content, so a tile whose first line is a Latin ticker and whose second is
 * Persian gets both right with no locale plumbing. Verified against an
 * HTML `dir="rtl"` control for pure-Persian, mixed, and pure-Latin content.
 */
describe("market map — Arabic-script text in WebKit", () => {
  it("suppresses letter-spacing for RTL text, at every size", () => {
    for (const size of [10, 14, 20, 28, 34]) {
      expect(trackingFor(size, FA)).toBe(0);
    }
  });

  it("keeps the designed tracking for Latin text, unchanged", () => {
    // Guards the fix against being a blanket removal: tracking is a real
    // design decision on the Latin map and these are the shipped values.
    expect(trackingFor(34, "Fed holds")).toBe(-0.022);
    expect(trackingFor(20, "Fed holds")).toBe(-0.015);
    expect(trackingFor(14, "Fed holds")).toBe(-0.005);
    expect(trackingFor(10, "Fed holds")).toBe(0.005);
    // ...and with no text at all, which is the width-floor's caller.
    expect(trackingFor(20)).toBe(-0.015);
  });

  it("keeps the width budget and the painted tracking in agreement", () => {
    // The budget folds tracking into charAdvance. If paint stopped applying
    // tracking while the budget still charged it, RTL text would be painted
    // WIDER than measured — tracking is negative at these sizes — and would
    // overflow the tile it was just proved to fit.
    expect(charAdvance(20, FA)).toBe(AVG_CHAR_W);
    expect(charAdvance(20, "Fed")).toBe(AVG_CHAR_W + trackingFor(20, "Fed"));
  });

  it("treats a mixed Persian/Latin line as RTL", () => {
    // Real tile content: a translated headline that kept its ticker.
    expect(trackingFor(20, "طلا USD/JPY 158.0")).toBe(0);
  });

  const tile = (lines: string[]) => renderToStaticMarkup(
    <svg><MapTile x={0} y={0} w={200} h={120} tone="bull" title="t"
      lines={lines} messages={messages} fontSize={20} /></svg>,
  );

  it("isolates every tspan of a Persian label so lines cannot bleed", () => {
    const html = tile(FA_LINES);
    const tspans = html.match(/<tspan[^>]*>/g) ?? [];
    expect(tspans).toHaveLength(FA_LINES.length);
    for (const t of tspans) expect(t).toContain("unicode-bidi:plaintext");
  });

  it("isolates Latin tspans the same way", () => {
    // plaintext resolves to LTR for Latin content, so one uniform rule
    // serves both locales — no branch to get wrong, and the English map is
    // covered by the same guard.
    const tspans = tile(EN_LINES).match(/<tspan[^>]*>/g) ?? [];
    expect(tspans).toHaveLength(EN_LINES.length);
    for (const t of tspans) expect(t).toContain("unicode-bidi:plaintext");
  });

  it("paints no non-zero letter-spacing on a Persian tile label", () => {
    // `0em` specifically is fine, and that is an empirical result rather than
    // an assumption: rendered in WebKit, `letter-spacing: 0em` on Persian is
    // pixel-identical to omitting the property and to `normal`. The bug needs
    // a NON-ZERO value. So this asserts the value, not the property's absence
    // — demanding absence would be a stricter contract than the rendering
    // actually requires, and would fail a correct implementation.
    //
    // Every letter-spacing in this markup belongs to the label: the meta
    // readout and the EN marker are off for this tile (importance "none",
    // fallback false) and are Latin-only anyway, so they keep their tracking.
    const spacings = [...tile(FA_LINES).matchAll(/letter-spacing:\s*(-?[0-9.]+)em/g)]
      .map(m => Number(m[1]));
    expect(spacings.every(v => v === 0)).toBe(true);
  });

  it("still paints tracking on a Latin tile label", () => {
    expect(tile(EN_LINES)).toMatch(/letter-spacing:\s*-0\.015em/);
  });

  const header = (label: string) => renderToStaticMarkup(
    <svg><MapGroupHeader x={0} y={0} w={400} label={label} /></svg>,
  );

  it("paints no letter-spacing on a Persian group header", () => {
    // The group headers were the most visibly broken part of the report:
    // short, large, and every one of them reversed.
    expect(header(FA)).not.toMatch(/letter-spacing:\s*[0-9.]+em/);
  });

  it("still paints letter-spacing on a Latin group header", () => {
    expect(header("Rates and dollar")).toMatch(/letter-spacing:\s*0\.08em/);
  });
});

describe("arc gauge — the same WebKit defect, found while auditing", () => {
  it("suppresses letter-spacing when its caption is Persian", () => {
    // value null so the caption is `label · <common.noData>` — both halves
    // translated, which is what made this reversed in Persian.
    const html = renderToStaticMarkup(
      <ArcGauge label="شاخص قدرت نسبی" value={null} min={0} max={100} messages={fa} />);
    expect(html).not.toMatch(/letter-spacing:\s*0\.08em/);
    expect(html).toContain("unicode-bidi:plaintext");
  });

  it("keeps letter-spacing for an English caption", () => {
    const html = renderToStaticMarkup(
      <ArcGauge label="RSI 14" value={62} min={0} max={100} messages={messages} />);
    expect(html).toMatch(/letter-spacing:\s*0\.08em/);
  });
});
