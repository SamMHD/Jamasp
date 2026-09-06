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

  it("still carries the real yield — it is gold's dominant driver", () => {
    // state/watchlist.yaml's fed-rate-path entry opens "Real yields are
    // gold's dominant driver". The tile has no live widget behind it and
    // therefore looked like a failure, and deleting it was floated as the
    // fix; this pins that the presentation was changed and the driver was
    // not. A vendor's symbol coverage must not decide what the desk sees.
    expect(DRIVER_SPECS.map(s => s.symbol)).toContain("DFII10");
  });

  it("puts the driver with no live widget last", () => {
    // The whole ordering rule, in one assertion, and the only place it is
    // enforced: components/driver-panel.tsx and the overview's ticker tape
    // both just iterate this array. See the comment on DRIVER_SPECS for why
    // last is the right place for it rather than second.
    expect(DRIVER_SPECS[DRIVER_SPECS.length - 1].symbol).toBe("DFII10");
    expect(DRIVER_SPECS.map(s => s.label)).toEqual(
      ["DXY", "US 10y", "USD/JPY", "S&P 500", "BTC", "US 10y real"]);
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
