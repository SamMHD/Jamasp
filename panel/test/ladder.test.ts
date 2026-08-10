import { describe, expect, it } from "vitest";
import { ladderGaps } from "../components/level-ladder";

describe("ladderGaps", () => {
  it("returns one gap fewer than there are levels", () => {
    expect(ladderGaps([100, 90, 50]).length).toBe(2);
  });

  it("gives the widest price gap the maximum spacing", () => {
    const [g1, g2] = ladderGaps([100, 90, 40], { min: 8, max: 48 });
    expect(g2).toBe(48);
    expect(g1).toBeLessThan(g2);
  });

  it("never returns less than the minimum, so labels cannot collide", () => {
    expect(ladderGaps([100, 99.999, 40], { min: 8, max: 48 })[0]).toBeGreaterThanOrEqual(8);
  });

  it("uses the minimum throughout when every level is identical", () => {
    expect(ladderGaps([100, 100, 100], { min: 8, max: 48 })).toEqual([8, 8]);
  });

  it("returns an empty array for zero or one level", () => {
    expect(ladderGaps([])).toEqual([]);
    expect(ladderGaps([100])).toEqual([]);
  });
});
