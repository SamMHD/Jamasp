import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Delta, QuoteTile } from "../components/quote-tile";
import type { PricePoint } from "../lib/db";

const NOW = new Date("2026-08-11T12:00:00Z");
const pt = (ts: string, value: number): PricePoint => ({ ts, value });

describe("Delta", () => {
  it("renders '<label> —' when no honest reference exists", () => {
    const html = renderToStaticMarkup(<Delta delta={null} label="24h" />);
    expect(html).toContain("24h —");
    expect(html).not.toContain("▲");
    expect(html).not.toContain("▼");
    expect(html).not.toContain("0");
  });

  it("renders a rise and a fall with direction marks", () => {
    expect(renderToStaticMarkup(<Delta delta={1.25} />)).toContain("▲ 1.25");
    expect(renderToStaticMarkup(<Delta delta={-1.25} />)).toContain("▼ 1.25");
  });

  it("renders a literal zero as flat, in muted ink — distinct from unknown", () => {
    const html = renderToStaticMarkup(<Delta delta={0} />);
    expect(html).toContain("= 0");
    expect(html).toContain("text-muted-foreground");
  });

  it("neutral tone never wears the direction colours", () => {
    const html = renderToStaticMarkup(<Delta delta={16348} tone="neutral" digits={0} />);
    expect(html).toContain("▲ 16,348");
    expect(html).not.toContain("emerald");
    expect(html).not.toContain("destructive");
  });
});

describe("QuoteTile", () => {
  const series = [pt("2026-08-09T00:00:00Z", 99.2), pt("2026-08-10T00:00:00Z", 99.7)];

  it("renders value, delta, sparkline and age", () => {
    const html = renderToStaticMarkup(
      <QuoteTile label="DXY" value={99.71} ts="2026-08-10T03:06:09Z"
        delta={-0.5} series={series} now={NOW} />);
    expect(html).toContain("DXY");
    expect(html).toContain("99.71");
    expect(html).toContain("▼ 0.5");
    expect(html).toContain("<svg");
    expect(html).toContain("ago");   // the age line is unconditional
  });

  it("states 'no data' for a symbol with no rows — no figure, no sparkline", () => {
    const html = renderToStaticMarkup(
      <QuoteTile label="US 10y real" value={null} ts={null} delta={null} now={NOW} />);
    expect(html).toContain("US 10y real");
    expect(html).toContain("no data");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("24h");
  });

  it("draws no trend line from a single print", () => {
    const html = renderToStaticMarkup(
      <QuoteTile label="US 10y" value={4.66} ts="2026-08-07T18:20:00Z"
        delta={null} series={[pt("2026-08-07T18:20:00Z", 4.66)]} now={NOW} />);
    expect(html).toContain("4.66");
    expect(html).toContain("24h —");
    expect(html).not.toContain("<svg");
  });

  it("renders no delta slot at all when the tile makes no change claim", () => {
    // undefined delta = not applicable — distinct from null ("reference
    // missing"), which must still render "24h —".
    const html = renderToStaticMarkup(
      <QuoteTile label="ATR14" value={105.1} digits={1} ts="2026-08-09T21:32:04Z"
        note="1.4% of spot" now={NOW} />);
    expect(html).toContain("105.1");
    expect(html).not.toContain("24h");
    expect(html).not.toContain("—");
  });

  it("carries a cadence note when given one", () => {
    const html = renderToStaticMarkup(
      <QuoteTile label="Net spec" value={190648} digits={0} ts="2026-08-04T00:00:00Z"
        delta={16348} deltaLabel="w/w" deltaTone="neutral" note="CFTC weekly" now={NOW} />);
    expect(html).toContain("190,648");
    expect(html).toContain("CFTC weekly");
    expect(html).toContain("w/w");
  });
});
