import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sparkline } from "../components/sparkline";
import type { PricePoint } from "../lib/db";

const pt = (ts: string, value: number): PricePoint => ({ ts, value });

describe("Sparkline", () => {
  it("renders nothing for zero points", () => {
    expect(renderToStaticMarkup(<Sparkline points={[]} />)).toBe("");
  });

  it("renders nothing for a single point (no line to draw)", () => {
    const html = renderToStaticMarkup(<Sparkline points={[pt("2026-08-01T00:00:00Z", 3300)]} />);
    expect(html).toBe("");
  });

  it("renders a path for two or more points", () => {
    const html = renderToStaticMarkup(<Sparkline points={[
      pt("2026-08-01T00:00:00Z", 3300),
      pt("2026-08-01T01:00:00Z", 3310),
    ]} />);
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
  });

  it("handles a flat series (every value identical) without dividing by zero", () => {
    const html = renderToStaticMarkup(<Sparkline points={[
      pt("2026-08-01T00:00:00Z", 3300),
      pt("2026-08-01T01:00:00Z", 3300),
      pt("2026-08-01T02:00:00Z", 3300),
    ]} />);
    // span would be 0 without the `|| 1` fallback, producing NaN/Infinity
    // coordinates and a broken `d` attribute.
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).toContain('d="M0.00,100.00 L50.00,100.00 L100.00,100.00"');
  });
});
