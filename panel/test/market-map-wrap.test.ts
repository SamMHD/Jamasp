import { describe, expect, it } from "vitest";
import { wrapForTile } from "../components/map-tiles";

/**
 * `wrapForTile` is the FLOOR case — the size labels fall back to when a tile
 * cannot hold the whole text at any larger size. `fitLabel` (see
 * test/map-label-fit.test.ts) is what picks the size above it.
 *
 * Tile geometry maps to a character budget through `charAdvance(10)` — the
 * AVG_CHAR_W glyph estimate (0.66) plus the floor size's +0.005em tracking,
 * so 0.665: a 200px-wide tile leaves floor((200 - 8) / 6.65) = 28 characters
 * a line. Height maps to a line count through the line advance
 * (LABEL_FONT * LINE_RATIO = 12.0px).
 *
 * These numbers are deliberately spelled out rather than imported: if the
 * typography constants change, these tests should fail loudly and be
 * re-derived, not silently follow along. Both have now been re-derived
 * twice. AVG_CHAR_W was 0.58 until labels were sized to fill their tiles —
 * an estimate that only picked a truncation point could sit on the true
 * average, but one that decides how large text is SET has to sit above the
 * widest label, or the biggest tiles overflow. LINE_RATIO was 1.25 until
 * wrapped labels were centred as a block, where 1.25 read as separate
 * stacked captions rather than one paragraph.
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
    // 90px allows 1 + floor((90 - 8 - 10) / 12) = 7 lines, which is more than
    // this text needs; 24px allows 1 + floor((24 - 8 - 10) / 12) = 1, which
    // is fewer. The short height was 30px while the line advance was 12.5px
    // (30 bought exactly one line then, and buys two now) — re-derived to a
    // height that is unambiguously one line either way, so this asserts the
    // behaviour rather than a boundary case of the advance.
    const text = "one two three four five six seven eight nine ten";
    expect(wrapForTile(text, WIDE, 90).length)
      .toBeGreaterThan(wrapForTile(text, WIDE, 24).length);
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

  it("breaks an over-long word at its hyphen or underscore first", () => {
    // The seam is a break a reader loses nothing to. Cutting mid-run when
    // one is available is what put "net_sp" / "ec 1d" on the live technical
    // map's narrowest tile. 54px leaves floor((54 - 8) / 6.65) = 6
    // characters, which "net_spec" (8) exceeds either way — the question is
    // only where it parts.
    expect(wrapForTile("net_spec 1d", 54, 190)).toEqual(["net_", "spec", "1d"]);
    expect(wrapForTile("three-week low", 54, 190)).toEqual(["three-", "week", "low"]);
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
