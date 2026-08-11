import { describe, expect, it } from "vitest";
import { deriveDriver, printDelta, DRIVER_SPECS } from "../lib/drivers";
import type { PricePoint } from "../lib/db";

const pt = (ts: string, value: number): PricePoint => ({ ts, value });
const SPEC = { symbol: "DX-Y.NYB", label: "DXY", digits: 2 };

describe("deriveDriver", () => {
  it("computes the 24h delta from an honest reference", () => {
    const d = deriveDriver(SPEC, { ts: "2026-08-10T03:00:00Z", value: 99.7 }, 100.2, []);
    expect(d.delta24h).toBeCloseTo(-0.5, 6);
    expect(d.label).toBe("DXY");
  });

  it("keeps the delta null when no reference exists (frozen feed)", () => {
    const d = deriveDriver(SPEC, { ts: "2026-08-10T03:00:00Z", value: 99.7 }, null, []);
    expect(d.delta24h).toBeNull();
  });

  it("keeps the delta null when the symbol has no rows at all", () => {
    const d = deriveDriver(SPEC, null, null, []);
    expect(d.quote).toBeNull();
    expect(d.delta24h).toBeNull();
  });

  it("never renders a percentage field — deltas are absolute by design", () => {
    // The overview E2E forbids the string "0.00%"; the type simply has no
    // pct member, so a future addition must consciously fight this test.
    const d = deriveDriver(SPEC, { ts: "t", value: 1 }, 1, []);
    expect(Object.keys(d).sort()).toEqual(
      ["delta24h", "digits", "label", "quote", "series", "symbol"]);
  });
});

describe("DRIVER_SPECS", () => {
  it("names only symbols the ingest actually stores", () => {
    const known = new Set(["DX-Y.NYB", "DFII10", "^TNX", "USDJPY", "^GSPC", "BTC-USD"]);
    for (const s of DRIVER_SPECS) expect(known.has(s.symbol)).toBe(true);
  });
});

describe("printDelta", () => {
  it("returns the change from the previous distinct print", () => {
    const r = printDelta([pt("2026-07-28T00:00:00Z", 174_300), pt("2026-08-04T00:00:00Z", 190_648)]);
    expect(r).not.toBeNull();
    expect(r!.delta).toBeCloseTo(16_348, 6);
    expect(r!.prevTs).toBe("2026-07-28T00:00:00Z");
  });

  it("is null for a single print — one observation is a value, not a change", () => {
    expect(printDelta([pt("2026-08-04T00:00:00Z", 190_648)])).toBeNull();
  });

  it("is null for an empty series", () => {
    expect(printDelta([])).toBeNull();
  });

  it("skips duplicate-timestamp rows rather than diffing a print against itself", () => {
    const r = printDelta([
      pt("2026-07-28T00:00:00Z", 174_300),
      pt("2026-08-04T00:00:00Z", 190_648),
      pt("2026-08-04T00:00:00Z", 190_648),
    ]);
    expect(r!.prevTs).toBe("2026-07-28T00:00:00Z");
  });

  it("is null when every row shares one timestamp", () => {
    expect(printDelta([pt("t", 1), pt("t", 1)])).toBeNull();
  });
});
