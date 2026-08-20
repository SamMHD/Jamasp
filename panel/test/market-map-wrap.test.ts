import { describe, expect, it } from "vitest";
import { wrapForTile } from "../components/market-map";

/**
 * Tile geometry maps to a character budget through AVG_CHAR_W (0.58) at
 * LABEL_FONT (10): a 200px-wide tile leaves floor((200 - 8) / 5.8) = 33
 * characters a line. Height maps to a line count through LINE_H
 * (LABEL_FONT * 1.25 = 12.5px).
 *
 * These numbers are deliberately spelled out rather than imported: if the
 * typography constants change, these tests should fail loudly and be
 * re-derived, not silently follow along.
 */
const WIDE = 200;

describe("wrapForTile", () => {
  it("wraps on word boundaries, never mid-word", () => {
    const lines = wrapForTile(
      "Gold jumps as Treasury buyback plans push yields lower", WIDE, 80);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).not.toMatch(/^\s|\s$/);
    expect(lines.join(" ")).toContain("Treasury");
    expect(lines.join(" ")).toContain("buyback");
  });

  it("uses the height it is given — a taller tile takes more lines", () => {
    const text = "one two three four five six seven eight nine ten";
    expect(wrapForTile(text, WIDE, 90).length)
      .toBeGreaterThan(wrapForTile(text, WIDE, 30).length);
  });

  it("returns a single line when only one fits", () => {
    // MIN_LABEL_H is 18px — one line plus padding. At that height the output
    // must match the pre-wrap behaviour exactly: one line, no more.
    expect(wrapForTile("alpha beta gamma delta", WIDE, 18)).toHaveLength(1);
  });

  it("ellipsises the last line when the headline overruns the tile", () => {
    const lines = wrapForTile(
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
      WIDE, 30);
    expect(lines[lines.length - 1]).toMatch(/…$/);
  });

  it("does not ellipsise a headline that fits", () => {
    expect(wrapForTile("short one", WIDE, 80)).toEqual(["short one"]);
  });

  it("hard-breaks a single word longer than the line", () => {
    // There is no word boundary to wrap on, so the only alternative to
    // breaking is overflowing the tile — the exact thing the label budget
    // exists to prevent.
    const lines = wrapForTile("Supercalifragilisticexpialidocious", 60, 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(9);
  });

  it("returns nothing for a tile too small for any text", () => {
    expect(wrapForTile("anything", 5, 5)).toEqual([]);
  });

  it("never emits an empty line", () => {
    // An empty <tspan> still advances the baseline, so a blank line would
    // punch a visible gap through the middle of a headline.
    const lines = wrapForTile(
      "  Gold   jumps    as  Treasury   buyback  ", WIDE, 90);
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
  });
});
