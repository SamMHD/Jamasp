import { describe, expect, it } from "vitest";
import {
  LABEL_FONT, LABEL_FONT_MAX, LABEL_PAD, LINE_RATIO,
  MIN_LABEL_H, MIN_LABEL_W, charAdvance, fitLabel,
} from "../components/map-tiles";

/**
 * Both maps size every label to its own rectangle. The failure that matters
 * is text hanging outside the tile it labels — a treemap tile is a claim
 * about area, and a headline spilling into the neighbouring tile reads as
 * that neighbour's headline. So most of these assert containment rather than
 * an exact size: the exact size is an estimate and allowed to move, the
 * containment is not.
 *
 * Ascent + descent, not the bare font size, is what a line actually paints
 * (0.97 + 0.25 in Inter). The height assertions use that, because charging
 * only the font size is precisely the mistake that put descenders through
 * the bottom edge of the largest tiles.
 */
const PAINTED_LINE = 1.22;

/**
 * Width of the longest wrapped line, in px, at the estimate the fit uses.
 *
 * `charAdvance`, not the bare AVG_CHAR_W: labels are tracked by size now
 * (tight at the ceiling, slightly open at the floor), and letter-spacing is
 * part of how wide a line actually paints. Measuring with the untracked
 * glyph estimate would report a 34px line as ~3% wider than it is and a 10px
 * line as narrower — neither is the number this containment check is about.
 */
function paintedWidth(lines: string[], fontSize: number): number {
  return Math.max(...lines.map(l => l.length)) * fontSize * charAdvance(fontSize);
}

function paintedHeight(lines: string[], fontSize: number): number {
  return fontSize * PAINTED_LINE + (lines.length - 1) * fontSize * LINE_RATIO;
}

/**
 * Every label must sit inside its own RECTANGLE, at any tile size — that is
 * the invariant that matters, and it holds at every size including the floor.
 *
 * The tighter padded-box guarantee holds only above the floor, and the
 * difference is deliberate rather than sloppy: the floor budget charges a
 * line its font size rather than its painted ascent+descent, which is what
 * lets a 10px label live in an 18px tile at all (the ~2px of overhang is
 * absorbed by the padding). Asserting the padded box everywhere would forbid
 * that, and quietly drop labels the maps have always shown.
 */
function expectInside(text: string, w: number, h: number): void {
  const { fontSize, lines } = fitLabel(text, w, h);
  if (!lines.length) return;

  // Text starts one pad in from the left, so it has w - LABEL_PAD to the edge.
  expect(paintedWidth(lines, fontSize)).toBeLessThanOrEqual(w - LABEL_PAD);
  expect(paintedHeight(lines, fontSize)).toBeLessThanOrEqual(h);

  if (fontSize > LABEL_FONT) {
    expect(paintedWidth(lines, fontSize)).toBeLessThanOrEqual(w - LABEL_PAD * 2);
    expect(paintedHeight(lines, fontSize)).toBeLessThanOrEqual(h - LABEL_PAD * 2);
  }
}

describe("fitLabel", () => {
  it("sets a big tile's label far larger than a small tile's", () => {
    // The whole point: one fixed size across a treemap wastes the area
    // channel the layout worked to compute.
    const big = fitLabel("rsi14 1d", 400, 300).fontSize;
    const small = fitLabel("rsi14 1d", 60, 24).fontSize;
    expect(big).toBeGreaterThan(small * 3);
    expect(small).toBe(LABEL_FONT);
  });

  it("grows monotonically with the tile it is given", () => {
    const sizes = [80, 160, 240, 320].map(
      w => fitLabel("Gold holds", w, w * 0.6).fontSize);
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    }
  });

  it("never sets text outside the tile, across a sweep of tile shapes", () => {
    const texts = [
      "adx 1w",
      "sma200 1d",
      "net_spec 1d",
      "Fed holds rates steady, Powell signals patience on the next cut",
      "Supercalifragilisticexpialidocious",
    ];
    for (const text of texts) {
      for (const w of [40, 55, 80, 120, 200, 320, 600]) {
        for (const h of [16, 20, 40, 90, 180, 400]) {
          expectInside(text, w, h);
        }
      }
    }
  });

  it("honours the ceiling however much room the tile has", () => {
    expect(fitLabel("up", 1200, 600).fontSize).toBe(LABEL_FONT_MAX);
  });

  it("never goes below the floor — it drops the label instead", () => {
    // A sliver is better left as pure colour than filled with single
    // broken-up letters, and MIN_LABEL_* is where that line is drawn.
    const { fontSize, lines } = fitLabel("Gold jumps", MIN_LABEL_W - 1, 200);
    expect(lines).toEqual([]);
    expect(fontSize).toBe(LABEL_FONT);
    expect(fitLabel("Gold jumps", 200, MIN_LABEL_H - 1).lines).toEqual([]);
  });

  it("still labels a tile exactly at the threshold", () => {
    expect(fitLabel("Gold", MIN_LABEL_W, MIN_LABEL_H).lines.length).toBe(1);
  });

  it("prefers a smaller size to breaking a word in half", () => {
    // "bollinger" split across lines as "bolling"/"er" is the wrong trade:
    // a legible whole word one step smaller beats a shattered larger one.
    //
    // Asserted on the joined lines rather than on the array, because WHICH
    // line the word lands on is not what this is about. It used to come back
    // as ["bollinger", "4h"]; since the fit started preferring a size whose
    // lines can hold MIN_LINE_CHARS characters it comes back as
    // ["bollinger 4h"], one step smaller and on one line — the same trade,
    // taken one step further. Either is a pass; "bolling"/"er" is not.
    const { lines } = fitLabel("bollinger 4h", 150, 120);
    expect(lines.join(" ")).toContain("bollinger");
    for (const line of lines) expect(line).not.toMatch(/bolling$|^er\b/);
  });

  it("falls back to the floor size when no size fits the text whole", () => {
    // A tile too narrow for its longest word cannot be fitted at any size, so
    // the search bottoms out and the floor's hard-breaking takes over — which
    // is the smallest type and therefore the FEWEST breaks available. All the
    // text is still there; it is only the shape that suffers.
    const { fontSize, lines } = fitLabel("Election polling tightens", 57, 111);
    expect(fontSize).toBe(LABEL_FONT);
    expect(lines.join("")).toBe("Electionpollingtightens");
  });

  it("ellipsises at the floor when the text genuinely does not fit", () => {
    // A short tile has no room to hard-break into. Truncation must be
    // visible: on a map whose whole job is showing what is there, a silently
    // clipped headline reads as the whole headline.
    const { fontSize, lines } = fitLabel(
      "Fed holds rates steady, Powell signals patience on the next cut", 120, 40);
    expect(fontSize).toBe(LABEL_FONT);
    expect(lines[lines.length - 1]).toMatch(/…$/);
  });

  it("wraps a long headline over many lines rather than shrinking to fit one", () => {
    const { lines } = fitLabel(
      "Fed holds rates steady, Powell signals patience on the next cut", 260, 380);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join(" ")).toContain("Powell");
  });

  it("gives up a size step rather than set one word per line", () => {
    // The size search maximises type size, and maximising type size
    // minimises how many characters fit on a line. Left alone it set
    // "Dollar index slides to a three-week low" as six lines with "a" alone
    // on one of them. A line has to be able to hold MIN_LINE_CHARS
    // characters before the size is accepted.
    const { fontSize, lines } = fitLabel(
      "Dollar index slides to a three-week low", 200, 300);
    expect(lines.length).toBeLessThanOrEqual(4);
    // A short remainder on the LAST line is just how text ends; a stranded
    // one- or two-letter word anywhere above it is the failure.
    for (const line of lines.slice(0, -1)) expect(line.length).toBeGreaterThan(3);
    // Still well above the floor: this buys readability with a step or two
    // of size, not with all of it.
    expect(fontSize).toBeGreaterThan(LABEL_FONT * 2);
  });

  it("puts a short label on one line when the tile is wide enough", () => {
    // "macd 4h" used to stack as "macd" / "4h" at the ceiling size, which
    // reads as two labels of equal weight rather than one signal and its
    // timeframe. Short text asks for room for its whole self, not for
    // MIN_LINE_CHARS characters it has no words to fill.
    expect(fitLabel("macd 4h", 200, 144).lines).toEqual(["macd 4h"]);
  });

  it("evens out the lines rather than filling each to the brim", () => {
    // Greedy wrapping packs every line and leaves the remainder on the last
    // one. Same size, same line count, less rag.
    const { lines } = fitLabel(
      "Fed holds rates steady, Powell signals patience on the next cut",
      340, 320);
    const lengths = lines.map(l => l.length);
    expect(lines.length).toBeGreaterThan(2);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(6);
  });

  it("still labels a tile too narrow for MIN_LINE_CHARS at any size", () => {
    // The line-length rule is a preference, not a gate: a stack of short
    // lines beats no label, so a tile that cannot satisfy it still gets the
    // largest label that fits.
    const { lines } = fitLabel("Gold holds", 60, 200);
    expect(lines.join(" ")).toBe("Gold holds");
  });

  it("returns no label for empty or whitespace-only text", () => {
    expect(fitLabel("", 400, 300).lines).toEqual([]);
    expect(fitLabel("   ", 400, 300).lines).toEqual([]);
  });

  it("returns no label for a degenerate tile", () => {
    expect(fitLabel("anything", 0, 0).lines).toEqual([]);
    expect(fitLabel("anything", -5, 100).lines).toEqual([]);
  });
});
