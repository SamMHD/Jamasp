import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpotChart, niceTicks } from "../components/spot-chart";
import type { PricePoint } from "../lib/db";

const pt = (ts: string, value: number): PricePoint => ({ ts, value });

const SERIES = [
  pt("2026-08-01T00:00:00Z", 4300),
  pt("2026-08-05T00:00:00Z", 4350),
  pt("2026-08-10T00:00:00Z", 4383.7),
];

describe("SpotChart", () => {
  it("renders a server-side SVG with the series path and an end marker", () => {
    const html = renderToStaticMarkup(<SpotChart points={SERIES} levels={[]} />);
    expect(html).toContain("<svg");
    expect(html).toContain('stroke="var(--viz-spot)"');
    expect(html).toContain("<circle");
    expect(html).not.toContain("NaN");
  });

  it("draws only the levels inside the price window and names them", () => {
    const html = renderToStaticMarkup(<SpotChart points={SERIES} levels={[
      { label: "50DMA", value: 4340 },        // inside
      { label: "pivot S1", value: 3974.8 },   // far below — ladder's job
    ]} />);
    expect(html).toContain("50DMA");
    expect(html).not.toContain("pivot S1");
  });

  it("keeps every value reachable without hover: the table view twin", () => {
    const html = renderToStaticMarkup(<SpotChart points={SERIES} levels={[]} />);
    expect(html).toContain("view as table");
    expect(html).toContain("4,383.7");
  });

  it("carries native hover readouts that pair value with timestamp", () => {
    const html = renderToStaticMarkup(<SpotChart points={SERIES} levels={[]} />);
    expect(html).toContain("<title>");
    expect(html).toContain("4,383.7 — Aug 10 00:00Z");
  });

  it("states 'not enough price history' below two points — no empty axes", () => {
    for (const points of [[], [pt("2026-08-10T00:00:00Z", 4383.7)]]) {
      const html = renderToStaticMarkup(<SpotChart points={points} levels={[]} />);
      expect(html).toContain("not enough price history");
      expect(html).not.toContain("<svg");
    }
  });

  it("survives a flat series without dividing by zero", () => {
    const html = renderToStaticMarkup(<SpotChart points={[
      pt("2026-08-01T00:00:00Z", 4300), pt("2026-08-02T00:00:00Z", 4300),
    ]} levels={[]} />);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  });
});

describe("niceTicks", () => {
  it("produces round steps covering the range", () => {
    const ticks = niceTicks(4278, 4462);
    expect(ticks.every(t => t % 50 === 0)).toBe(true);
    expect(ticks[0]).toBeGreaterThanOrEqual(4278);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(4462);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });

  it("degrades to a single tick on a zero span", () => {
    expect(niceTicks(5, 5)).toEqual([5]);
  });
});
