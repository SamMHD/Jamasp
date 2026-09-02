import { describe, expect, it } from "vitest";
import { contrast, deltaE2000, hexToRgb, labOf, simulateCvd } from "@/lib/color";

describe("contrast", () => {
  it("is 21:1 for black on white", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 2);
  });
  it("is 1:1 for a colour against itself", () => {
    expect(contrast("#d4a73e", "#d4a73e")).toBeCloseTo(1, 6);
  });
  it("is symmetric", () => {
    expect(contrast("#161716", "#8d8d86")).toBeCloseTo(contrast("#8d8d86", "#161716"), 9);
  });
});

describe("hexToRgb", () => {
  it("normalises to 0..1", () => {
    expect(hexToRgb("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
  });
});

describe("labOf", () => {
  // D65 reference white: L*=100, a*=b*=0.
  it("puts white at L*100 with no chroma", () => {
    const [L, a, b] = labOf("#ffffff");
    expect(L).toBeCloseTo(100, 2);
    expect(a).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
  });
  it("puts black at L*0", () => {
    expect(labOf("#000000")[0]).toBeCloseTo(0, 2);
  });
});

describe("deltaE2000", () => {
  it("is 0 for identical colours", () => {
    expect(deltaE2000(labOf("#1baf7a"), labOf("#1baf7a"))).toBeCloseTo(0, 9);
  });
  it("is symmetric", () => {
    const a = labOf("#1baf7a"), b = labOf("#e34948");
    expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 9);
  });
  // Sharma et al. CIEDE2000 test data, pair 1.
  it("matches the Sharma reference pair", () => {
    const d = deltaE2000([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485]);
    expect(d).toBeCloseTo(2.0425, 3);
  });
});

describe("simulateCvd", () => {
  it("leaves greys unchanged", () => {
    expect(simulateCvd("#808080", "deutan")).toBe("#808080");
  });
  it("collapses red and green toward each other under deuteranopia", () => {
    const before = deltaE2000(labOf("#1baf7a"), labOf("#e34948"));
    const after = deltaE2000(
      labOf(simulateCvd("#1baf7a", "deutan")),
      labOf(simulateCvd("#e34948", "deutan")),
    );
    expect(after).toBeLessThan(before);
  });
});
