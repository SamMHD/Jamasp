import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LevelLadder } from "../components/level-ladder";
import type { Level } from "../lib/technicals";

// Companion to ladder.test.ts, which covers ladderGaps (the pure maths).
// These two guards live in the presentational component itself and would
// not be exercised by a maths-only test: rendered here with
// renderToStaticMarkup rather than a DOM-testing library, since the project
// has no jsdom/testing-library setup and this needs none.
describe("LevelLadder", () => {
  it("shows a fallback message and no list when there are no levels", () => {
    const html = renderToStaticMarkup(<LevelLadder levels={[]} />);
    expect(html).toContain("no levels available");
    expect(html).not.toContain("<ol");
  });

  it("leaves the first row unspaced and spaces the rest", () => {
    const levels: Level[] = [
      { label: "200DMA", value: 3400, kind: "ma", side: "above" },
      { label: "spot", value: 3325, kind: "spot", side: "at" },
      { label: "50DMA", value: 3250, kind: "ma", side: "below" },
    ];
    const html = renderToStaticMarkup(<LevelLadder levels={levels} />);
    const rows = html.match(/<li[^>]*>/g) ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toContain("style=");
    expect(rows[1]).toContain("margin-top");
    expect(rows[2]).toContain("margin-top");
  });
});
