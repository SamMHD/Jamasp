import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArcGauge } from "../components/arc-gauge";

const render = (value: number | null) =>
  renderToStaticMarkup(
    <ArcGauge label="RSI14" value={value} min={0} max={100}
      ticks={[{ at: 30, text: "30" }, { at: 70, text: "70" }]} />);

describe("ArcGauge", () => {
  it("renders the value, a value arc and an end marker", () => {
    const html = render(66.1);
    expect(html).toContain("66.1");
    expect(html).toContain("<circle");                       // the end marker
    expect(html).toContain('stroke="var(--viz-spot)"');      // the value arc
    expect(html).toContain('aria-label="RSI14 66.1"');
  });

  // Zero is a value: it must produce a mark (the end marker at the left
  // terminus), unlike null, which must produce none.
  it("marks a literal zero rather than rendering it as absence", () => {
    const html = render(0);
    expect(html).toContain("<circle");
    expect(html).toContain('aria-label="RSI14 0"');
  });

  it("with a null value draws the track only — no arc, no marker parked at zero", () => {
    const html = render(null);
    expect(html).not.toContain("<circle");
    expect(html).not.toContain('stroke="var(--viz-spot)"');
    expect(html).toContain("—");
    expect(html).toContain("no data");
    expect(html).toContain('aria-label="RSI14: no data"');
  });

  it("renders threshold ticks as neutral reference marks", () => {
    const html = render(66.1);
    expect(html).toContain(">30</text>");
    expect(html).toContain(">70</text>");
    expect(html).toContain('stroke="var(--border)"');
  });

  it("clamps an out-of-range value visually but displays the true number", () => {
    const html = renderToStaticMarkup(
      <ArcGauge label="RSI14" value={104.2} min={0} max={100} />);
    expect(html).toContain("104.2");
    expect(html).not.toContain("NaN");
  });

  it("survives a degenerate min===max scale without drawing a fabricated arc", () => {
    const html = renderToStaticMarkup(
      <ArcGauge label="X" value={5} min={5} max={5} />);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("<circle");
  });
});
