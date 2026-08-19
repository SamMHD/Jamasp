import { describe, expect, it } from "vitest";
import { tierWeight, tone } from "../lib/marketmap";

describe("tierWeight", () => {
  it("maps the configured tier scale", () => {
    expect([5, 4, 3, 2, 1].map(tierWeight)).toEqual([100, 60, 30, 10, 3]);
  });

  it("falls back to the lowest weight for an unknown tier", () => {
    // A tier outside 1-5 should occupy space, not vanish or throw: the item
    // was scored, so it is news. Sizing it as noise is the safe reading.
    expect(tierWeight(0)).toBe(3);
    expect(tierWeight(9)).toBe(3);
  });
});

describe("tone", () => {
  it("returns the pole when direction and conviction are both strong", () => {
    expect(tone(2, 0.8)).toBe("bull");    // s = +0.80
    expect(tone(-2, 0.8)).toBe("bear");   // s = -0.80
  });

  it("returns the mid step for a moderate signed intensity", () => {
    expect(tone(1, 0.6)).toBe("bull-mid");   // s = +0.30
    expect(tone(-1, 0.6)).toBe("bear-mid");  // s = -0.30
  });

  it("returns neutral when conviction collapses the intensity", () => {
    // A tier-5 story nobody can call must render big and GREY. This is the
    // spec's stated intent, not an edge case.
    expect(tone(2, 0.1)).toBe("neutral");  // s = +0.10
  });

  it("returns neutral for direction 0 at any conviction", () => {
    expect(tone(0, 0.9)).toBe("neutral");
    expect(tone(0, 0.0)).toBe("neutral");
  });

  it("pins the step boundaries exactly", () => {
    // Boundaries are 0.15 and 0.55 on |s|; both are inclusive-low.
    expect(tone(1, 0.30)).toBe("bull-mid");   // s = 0.150 -> mid, not neutral
    expect(tone(1, 0.29)).toBe("neutral");    // s = 0.145
    expect(tone(2, 0.55)).toBe("bull");       // s = 0.550 -> pole, not mid
    expect(tone(2, 0.54)).toBe("bull-mid");   // s = 0.540
  });
});
