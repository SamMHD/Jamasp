import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LevelLadder } from "../components/level-ladder";
import type { Level } from "../lib/technicals";
import { getMessages } from "../lib/i18n";

const messages = getMessages("en");

// Companion to ladder.test.ts, which covers ladderGaps (the pure maths).
// These two guards live in the presentational component itself and would
// not be exercised by a maths-only test: rendered here with
// renderToStaticMarkup rather than a DOM-testing library, since the project
// has no jsdom/testing-library setup and this needs none.
describe("LevelLadder", () => {
  it("shows a fallback message and no list when there are no levels", () => {
    const html = renderToStaticMarkup(<LevelLadder levels={[]} messages={messages} />);
    expect(html).toContain("no levels available");
    expect(html).not.toContain("<ol");
  });

  it("leaves the first row unspaced and spaces the rest", () => {
    const levels: Level[] = [
      { label: "200DMA", value: 3400, kind: "ma", side: "above" },
      { label: "spot", value: 3325, kind: "spot", side: "at" },
      { label: "50DMA", value: 3250, kind: "ma", side: "below" },
    ];
    const html = renderToStaticMarkup(<LevelLadder levels={levels} messages={messages} />);
    const rows = html.match(/<li[^>]*>/g) ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toContain("style=");
    expect(rows[1]).toContain("margin-top");
    expect(rows[2]).toContain("margin-top");
  });
});

// Judgment call (see level-ladder.tsx's comment): "200DMA"/"50DMA"/"pivot
// R1"/"pivot S1" are ticker-like and stay Latin in both locales; "spot" is
// plain prose and translates. Asserted against the real fa.json, not a
// hand-typed guess, so a wording edit there cannot silently desync this test.
describe("LevelLadder — Persian", () => {
  it("translates 'spot' but leaves the MA/pivot shorthand in Latin", () => {
    const fa = getMessages("fa");
    const levels: Level[] = [
      { label: "200DMA", value: 3400, kind: "ma", side: "above" },
      { label: "spot", value: 3325, kind: "spot", side: "at" },
      { label: "pivot R1", value: 3390, kind: "pivot", side: "above" },
    ];
    const html = renderToStaticMarkup(<LevelLadder levels={levels} messages={fa} />);
    expect(html).toContain(fa["tech.levelSpot"]);
    expect(html).not.toContain(">spot<");
    expect(html).toContain("200DMA");
    expect(html).toContain("pivot R1");
  });
});
