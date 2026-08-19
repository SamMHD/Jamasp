import { describe, expect, it } from "vitest";
import { layoutMap, squarify, tierWeight, tone, type ScoredItem } from "../lib/marketmap";

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

const RECT = { x: 0, y: 0, w: 400, h: 300 };

function item(over: Partial<ScoredItem> = {}): ScoredItem {
  return {
    itemId: "a", tier: 3, direction: 1, conviction: 0.5, theme: "geopolitics",
    headline: "h", source: "s", url: "u", publishedAt: "2026-08-19T12:00:00Z",
    ...over,
  };
}

// Two rects overlap iff they overlap on both axes. EPS keeps shared edges
// (expected and correct between adjacent tiles) from reading as overlaps.
function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  const EPS = 1e-9;
  return a.x + a.w > b.x + EPS && b.x + b.w > a.x + EPS
      && a.y + a.h > b.y + EPS && b.y + b.h > a.y + EPS;
}

describe("squarify", () => {
  it("fills the rectangle exactly and never overlaps", () => {
    // Eight nodes of varied magnitude so row-breaking actually happens —
    // that is exactly where an overlap bug (e.g. one region double-counted
    // while another is shorted by the same area) would live. Area and
    // in-bounds checks alone can't catch that: two rects can each individually
    // satisfy both and still intersect each other. Hence the explicit
    // pairwise overlap check below.
    const cells = squarify(
      [10, 8, 6, 5, 4, 3, 2, 1].map((v, i) => ({ value: v, node: `n${i}` })),
      RECT);
    expect(cells).toHaveLength(8);
    const area = cells.reduce((s, c) => s + c.w * c.h, 0);
    expect(area).toBeCloseTo(RECT.w * RECT.h, 4);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(RECT.x - 1e-6);
      expect(c.y).toBeGreaterThanOrEqual(RECT.y - 1e-6);
      expect(c.x + c.w).toBeLessThanOrEqual(RECT.x + RECT.w + 1e-6);
      expect(c.y + c.h).toBeLessThanOrEqual(RECT.y + RECT.h + 1e-6);
    }
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        expect(overlaps(cells[i], cells[j])).toBe(false);
      }
    }
  });

  it("allocates area proportional to value", () => {
    const cells = squarify(
      [{ value: 3, node: "big" }, { value: 1, node: "small" }], RECT);
    const big = cells.find(c => c.node === "big")!;
    const small = cells.find(c => c.node === "small")!;
    expect((big.w * big.h) / (small.w * small.h)).toBeCloseTo(3, 4);
  });

  it("gives a single node the whole rectangle", () => {
    const [c] = squarify([{ value: 7, node: "only" }], RECT);
    // toBeCloseTo, not toEqual: the value -> area -> thick round-trip goes
    // through 120000/7, which is not representable in IEEE-754, so the width
    // lands 5.7e-14px short of 400. That is fourteen orders of magnitude
    // below a pixel; exact equality is not achievable and not worth
    // contorting the algorithm for.
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.y).toBeCloseTo(0, 6);
    expect(c.w).toBeCloseTo(400, 6);
    expect(c.h).toBeCloseTo(300, 6);
  });

  it("returns nothing for empty input or a zero-area rectangle", () => {
    expect(squarify([], RECT)).toEqual([]);
    expect(squarify([{ value: 1, node: "x" }], { x: 0, y: 0, w: 0, h: 10 }))
      .toEqual([]);
  });

  it("drops zero-value nodes rather than emitting zero-area cells", () => {
    // A zero-area rect would render as an invisible tile that still catches
    // a hover target. Better to omit it.
    const cells = squarify(
      [{ value: 5, node: "a" }, { value: 0, node: "b" }], RECT);
    expect(cells.map(c => c.node)).toEqual(["a"]);
  });
});

describe("layoutMap", () => {
  it("groups items into theme boxes sized by summed tier weight", () => {
    const boxes = layoutMap([
      item({ itemId: "1", theme: "rates_dollar", tier: 4 }),
      item({ itemId: "2", theme: "rates_dollar", tier: 4 }),
      item({ itemId: "3", theme: "geopolitics", tier: 3 }),
    ], RECT, 0);
    const rates = boxes.find(b => b.theme === "rates_dollar")!;
    const geo = boxes.find(b => b.theme === "geopolitics")!;
    expect(rates.total).toBe(120);  // 60 + 60
    expect(geo.total).toBe(30);
    expect((rates.w * rates.h) / (geo.w * geo.h)).toBeCloseTo(4, 3);
  });

  it("omits themes with no items entirely", () => {
    // physical_cb and etf_flows were both empty on the first live day. An
    // empty box would claim area and read as "nothing happened here" rather
    // than "nothing was filed here".
    const boxes = layoutMap([item({ theme: "geopolitics" })], RECT, 0);
    expect(boxes.map(b => b.theme)).toEqual(["geopolitics"]);
  });

  it("reserves the header strip so tiles never sit under the label", () => {
    const [box] = layoutMap([item()], RECT, 14);
    for (const c of box.items) {
      expect(c.y).toBeGreaterThanOrEqual(box.y + 14 - 1e-6);
      expect(c.y + c.h).toBeLessThanOrEqual(box.y + box.h + 1e-6);
    }
    // >= alone would pass a doubled or inflated offset too, since squarify
    // just fills whatever inner rect it's handed. Pin the top edge flush
    // against the header strip, not merely clear of it.
    const minY = Math.min(...box.items.map(c => c.y));
    expect(minY).toBeCloseTo(box.y + 14, 6);
  });

  it("returns an empty layout for no items", () => {
    expect(layoutMap([], RECT, 14)).toEqual([]);
  });
});
