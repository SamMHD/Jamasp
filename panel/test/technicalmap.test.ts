import { describe, expect, it } from "vitest";
import { buildSignalTiles, layoutSignalMap, type SignalState } from "@/lib/technicalmap";

const SPECS = [
  { name: "rsi14", family: "momentum", timeframes: ["1d", "4h"] },
  { name: "sma50", family: "trend", timeframes: ["1d"] },
];

const WEIGHTS = {
  fittedAt: "2026-08-20T04:17:00Z",
  fits: {
    technical: {
      n: 16880, horizonHours: 24, flags: [],
      coefficients: {
        "rsi14@1d": { beta: 0.03, se: 0.008, multiplier: 2.0,
                      observations: 900, fitted: true, pinned: false },
        "rsi14@4h": { beta: 0.001, se: 0.02, multiplier: 1.0,
                      observations: 3, fitted: false, pinned: false },
      },
    },
  },
};

const STATES: SignalState[] = [
  { key: "rsi14@1d", ts: "2026-08-20T00:00:00Z", value: 0.8, source: "bars" },
  { key: "rsi14@4h", ts: "2026-08-20T04:00:00Z", value: -0.3, source: "bars" },
  { key: "sma50@1d", ts: "2026-08-20T00:00:00Z", value: -0.9, source: "bars" },
];

describe("buildSignalTiles", () => {
  it("joins states to their family and their fitted multiplier", () => {
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    const byKey = Object.fromEntries(tiles.map(t => [t.key, t]));
    expect(byKey["rsi14@1d"].family).toBe("momentum");
    expect(byKey["rsi14@1d"].multiplier).toBe(2.0);
    expect(byKey["rsi14@1d"].fitted).toBe(true);
    expect(byKey["rsi14@1d"].state).toBe(0.8);
    expect(byKey["rsi14@1d"].signal).toBe("rsi14");
    expect(byKey["rsi14@1d"].timeframe).toBe("1d");
  });

  it("gives a column with no fitted coefficient a neutral, unfitted weight", () => {
    // Before the first fit every multiplier is 1.0 and the map is a uniform
    // grid. That is honest rather than broken — but it must be visibly
    // unfitted, or a grid of equal tiles reads as a measurement.
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    const sma = tiles.find(t => t.key === "sma50@1d")!;
    expect(sma.multiplier).toBe(1);
    expect(sma.fitted).toBe(false);
  });

  it("treats an under-observed column as unfitted even though it has a coefficient", () => {
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    expect(tiles.find(t => t.key === "rsi14@4h")!.fitted).toBe(false);
  });

  it("honours a pin on a column the fit never measured", () => {
    // The exact scenario Finding 2a names: a retro pins rsi14@4h (3
    // observations, unfitted) and jamasp/fit.py's run_fit already applies
    // pins[col] to `multiplier` regardless of `fitted` -- but the OLD
    // buildSignalTiles ignored that and fell back to NEUTRAL_MULTIPLIER
    // because it only ever checked `fitted`. The pin must reach the tile.
    const weights = {
      ...WEIGHTS,
      fits: { technical: { ...WEIGHTS.fits.technical, coefficients: {
        ...WEIGHTS.fits.technical.coefficients,
        "rsi14@4h": { beta: 0.001, se: 0.02, multiplier: 2.75,
                      observations: 3, fitted: false, pinned: true },
      } } },
    };
    const tiles = buildSignalTiles(STATES, SPECS, weights);
    const pinned = tiles.find(t => t.key === "rsi14@4h")!;
    expect(pinned.fitted).toBe(false);
    expect(pinned.pinned).toBe(true);
    expect(pinned.multiplier).toBe(2.75);
  });

  it("still weighs neutral a column that is neither fitted nor pinned", () => {
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    const sma = tiles.find(t => t.key === "sma50@1d")!;
    expect(sma.pinned).toBe(false);
    expect(sma.multiplier).toBe(1);
  });

  it("renders everything neutral and unfitted with no weights file at all", () => {
    const tiles = buildSignalTiles(STATES, SPECS, null);
    expect(tiles).toHaveLength(3);
    expect(tiles.every(t => t.multiplier === 1 && !t.fitted)).toBe(true);
  });

  it("drops a state whose column is not in the configured taxonomy", () => {
    // A stale signal_states row from a removed signal must not draw a tile
    // with no family to sit in.
    const tiles = buildSignalTiles(
      [...STATES,
       { key: "vibes@1d", ts: "2026-08-20T00:00:00Z", value: 1, source: "bars" }],
      SPECS, WEIGHTS);
    expect(tiles.map(t => t.key)).not.toContain("vibes@1d");
  });

  it("is empty when there are no states", () => {
    expect(buildSignalTiles([], SPECS, WEIGHTS)).toEqual([]);
  });
});

describe("layoutSignalMap", () => {
  it("groups by family and sizes by multiplier alone", () => {
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    const boxes = layoutSignalMap(tiles, { x: 0, y: 0, w: 400, h: 300 }, 20);
    expect(boxes.map(b => b.group).sort()).toEqual(["momentum", "trend"]);
    const momentum = boxes.find(b => b.group === "momentum")!;
    // rsi14@1d has multiplier 2.0 and rsi14@4h has 1.0, so the first tile
    // must be twice the area of the second. There is no tier for a signal:
    // area is the learned multiplier and nothing else, which is what makes
    // the Bourse analogy exact — shape is stable, colour is today's read.
    const areas = momentum.items
      .map(c => ({ key: c.node.key, area: c.w * c.h }));
    const big = areas.find(a => a.key === "rsi14@1d")!.area;
    const small = areas.find(a => a.key === "rsi14@4h")!.area;
    expect(big / small).toBeCloseTo(2.0, 2);
  });

  it("fills the whole canvas", () => {
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    const boxes = layoutSignalMap(tiles, { x: 0, y: 0, w: 400, h: 300 }, 0);
    const total = boxes.reduce((s, b) => s + b.w * b.h, 0);
    // Compare the RATIO, not the absolute area. toBeCloseTo(120000, 4) demands
    // agreement to 0.00005 on a six-figure number, which squarify's IEEE
    // round-trips cannot promise — the same trap that produced a spurious
    // failure at 399.99999999999994 when this layout first landed.
    expect(total / (400 * 300)).toBeCloseTo(1, 6);
  });
});

describe("signal provenance", () => {
  it("carries source through onto the tile", () => {
    const tiles = buildSignalTiles(
      [{ key: "rsi14@1d", ts: "2026-08-25T04:31:05Z", value: -0.6,
         source: "tradingview" }],
      SPECS, WEIGHTS);
    expect(tiles[0].source).toBe("tradingview");
  });

  it("defaults a row with no source to bars", () => {
    // A database written before signal_states gained its `source` column
    // holds only bar-computed states, which is what the fallback means.
    // Cast because the whole point is a row that predates the type.
    const legacy = [{ key: "rsi14@1d", ts: "2026-08-20T00:00:00Z", value: 0.4 }];
    const tiles = buildSignalTiles(legacy as never, SPECS, WEIGHTS);
    expect(tiles[0].source).toBe("bars");
  });
});
