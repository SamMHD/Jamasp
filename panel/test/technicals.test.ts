import { describe, expect, it } from "vitest";
import { deriveTechnicals, type TechnicalsInput } from "../lib/technicals";

const NOW = new Date("2026-08-01T12:00:00Z");
const q = (value: number, ts = "2026-08-01T06:00:00Z") => ({ ts, value });

const base: TechnicalsInput = {
  spot: q(3325, "2026-08-01T08:00:00Z"),
  spot24hAgo: 3310.5,
  sma50: q(3250), sma200: q(3400),
  pivotS1: q(3180), pivotR1: q(3390),
  rsi14: q(58.4), atr14: q(42.1),
  gvz: q(18.7, "2026-08-01T07:00:00Z"),
  netSpec: q(9.5, "2026-07-28T00:00:00Z"),
};

describe("deriveTechnicals — regime", () => {
  // These four strings must match jamasp/pricesummary.py#_tech_line exactly.
  it("above both", () => {
    expect(deriveTechnicals({ ...base, spot: q(3500) }, NOW).regime).toBe("above both");
  });
  it("below both", () => {
    expect(deriveTechnicals({ ...base, spot: q(3000) }, NOW).regime).toBe("below both");
  });
  it("above 50DMA, below 200DMA", () => {
    expect(deriveTechnicals(base, NOW).regime).toBe("above 50DMA, below 200DMA");
  });
  it("below 50DMA, above 200DMA", () => {
    expect(deriveTechnicals({ ...base, sma50: q(3400), sma200: q(3250) }, NOW).regime)
      .toBe("below 50DMA, above 200DMA");
  });
  it("treats spot exactly equal to an SMA as not-above, matching the Python's strict >", () => {
    expect(deriveTechnicals({ ...base, spot: q(3250), sma200: q(3400) }, NOW).regime)
      .toBe("below both");
  });
  it("is null when either SMA is missing", () => {
    expect(deriveTechnicals({ ...base, sma200: null }, NOW).regime).toBeNull();
    expect(deriveTechnicals({ ...base, sma50: null }, NOW).regime).toBeNull();
  });
  it("is null when spot is missing", () => {
    expect(deriveTechnicals({ ...base, spot: null }, NOW).regime).toBeNull();
  });
});

describe("deriveTechnicals — levels", () => {
  it("orders levels descending with spot interleaved", () => {
    const t = deriveTechnicals(base, NOW);
    expect(t.levels.map(l => [l.label, l.value])).toEqual([
      ["200DMA", 3400], ["pivot R1", 3390], ["spot", 3325],
      ["50DMA", 3250], ["pivot S1", 3180],
    ]);
  });

  it("tags each level above/below/at relative to spot", () => {
    const byLabel = Object.fromEntries(
      deriveTechnicals(base, NOW).levels.map(l => [l.label, l.side]));
    expect(byLabel).toEqual({
      "200DMA": "above", "pivot R1": "above", spot: "at",
      "50DMA": "below", "pivot S1": "below",
    });
  });

  it("marks a level equal to spot as at", () => {
    const t = deriveTechnicals({ ...base, sma50: q(3325) }, NOW);
    expect(t.levels.find(l => l.label === "50DMA")!.side).toBe("at");
  });

  it("renders only the levels it has", () => {
    const t = deriveTechnicals({ ...base, pivotS1: null, pivotR1: null }, NOW);
    expect(t.levels.map(l => l.label)).toEqual(["200DMA", "spot", "50DMA"]);
  });

  it("returns an empty ladder and null spot when there is no price data", () => {
    const t = deriveTechnicals({
      spot: null, spot24hAgo: null, sma50: null, sma200: null,
      pivotS1: null, pivotR1: null, rsi14: null, atr14: null,
      gvz: null, netSpec: null,
    }, NOW);
    expect(t.levels).toEqual([]);
    expect(t.spot).toBeNull();
    expect(t.regime).toBeNull();
    expect(t.indicatorsAsOf).toBeNull();
  });

  it("assigns kinds so the ladder can style MAs and pivots differently", () => {
    const kinds = Object.fromEntries(
      deriveTechnicals(base, NOW).levels.map(l => [l.label, l.kind]));
    expect(kinds).toEqual({
      "200DMA": "ma", "pivot R1": "pivot", spot: "spot",
      "50DMA": "ma", "pivot S1": "pivot",
    });
  });

  it("marks every level as at when spot is missing, rather than fabricating above/below", () => {
    const t = deriveTechnicals({ ...base, spot: null }, NOW);
    expect(t.levels.map(l => l.label)).toEqual(["200DMA", "pivot R1", "50DMA", "pivot S1"]);
    expect(t.levels.every(l => l.side === "at")).toBe(true);
  });
});

describe("deriveTechnicals — spot delta", () => {
  it("computes absolute and percentage 24h change", () => {
    const t = deriveTechnicals(base, NOW);
    expect(t.spot!.delta24h).toBeCloseTo(14.5, 6);
    expect(t.spot!.pct24h).toBeCloseTo((14.5 / 3310.5) * 100, 6);
  });

  it("leaves deltas null with no 24h reference", () => {
    const t = deriveTechnicals({ ...base, spot24hAgo: null }, NOW);
    expect(t.spot!.delta24h).toBeNull();
    expect(t.spot!.pct24h).toBeNull();
  });

  it("leaves pct null rather than dividing by zero", () => {
    const t = deriveTechnicals({ ...base, spot24hAgo: 0 }, NOW);
    expect(t.spot!.pct24h).toBeNull();
  });

  it("still computes delta24h against a literal-zero reference, distinct from a missing one", () => {
    const t = deriveTechnicals({ ...base, spot24hAgo: 0 }, NOW);
    expect(t.spot!.delta24h).toBe(3325);
  });
});

describe("deriveTechnicals — staleness", () => {
  it("is fresh within 12h of the newest TradingView-sourced indicator", () => {
    expect(deriveTechnicals(base, NOW).stale).toBe(false);
    expect(deriveTechnicals(base, NOW).indicatorsAsOf).toBe("2026-08-01T06:00:00Z");
  });

  it("boundary: exactly 12h is fresh, one minute past is stale", () => {
    const at = new Date("2026-08-01T18:00:00Z");   // 12h after 06:00Z
    expect(deriveTechnicals(base, at).stale).toBe(false);
    const past = new Date("2026-08-01T18:01:00Z");
    expect(deriveTechnicals(base, past).stale).toBe(true);
  });

  it("ignores GVZ and net spec, which have their own cadences", () => {
    // Only GVZ is recent; the TradingView set is two days old -> stale.
    const t = deriveTechnicals({
      ...base,
      sma50: q(3250, "2026-07-30T06:00:00Z"), sma200: q(3400, "2026-07-30T06:00:00Z"),
      pivotS1: q(3180, "2026-07-30T06:00:00Z"), pivotR1: q(3390, "2026-07-30T06:00:00Z"),
      rsi14: q(58.4, "2026-07-30T06:00:00Z"), atr14: q(42.1, "2026-07-30T06:00:00Z"),
      gvz: q(18.7, "2026-08-01T11:59:00Z"),
    }, NOW);
    expect(t.stale).toBe(true);
    expect(t.indicatorsAsOf).toBe("2026-07-30T06:00:00Z");
  });

  it("is not stale when there are no indicators at all", () => {
    const t = deriveTechnicals({
      ...base, sma50: null, sma200: null, pivotS1: null,
      pivotR1: null, rsi14: null, atr14: null,
    }, NOW);
    expect(t.stale).toBe(false);
    expect(t.indicatorsAsOf).toBeNull();
  });
});

describe("deriveTechnicals — indicators", () => {
  it("passes indicator values through, nulling the absent ones", () => {
    expect(deriveTechnicals({ ...base, atr14: null }, NOW).indicators)
      .toEqual({ rsi14: 58.4, atr14: null, gvz: 18.7, netSpec: 9.5 });
  });
});
