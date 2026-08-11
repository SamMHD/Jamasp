import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WeightBar } from "../components/weight-bar";
import type { StanceWeight } from "../lib/stance";

const W: StanceWeight[] = [
  { label: "base", pct: 70 },
  { label: "event-bearish", pct: 5 },
  { label: "kinetic", pct: 25 },
];

const render = (weights: StanceWeight[]) =>
  renderToStaticMarkup(<WeightBar weights={weights} />);

describe("WeightBar", () => {
  it("renders one segment per scenario, widths normalised to the sum", () => {
    const html = render(W);
    expect(html).toContain("width:70%");
    expect(html).toContain("width:5%");
    expect(html).toContain("width:25%");
    expect(html).toContain("var(--viz-1)");
    expect(html).toContain("var(--viz-2)");
    expect(html).toContain("var(--viz-3)");
  });

  it("repeats every label and value as plain text — identity is never colour-alone", () => {
    const html = render(W);
    expect(html).toContain("base 70%");
    expect(html).toContain("event-bearish 5%");
    expect(html).toContain("kinetic 25%");
  });

  it("normalises a triplet that does not sum to 100 instead of overflowing", () => {
    const html = render([
      { label: "a", pct: 60 }, { label: "b", pct: 60 }, { label: "c", pct: 80 },
    ]);
    expect(html).toContain("width:30%");   // 60/200
    expect(html).toContain("width:40%");   // 80/200
    expect(html).toContain("a 60%");       // the text keeps the raw claim
  });

  it("draws no bar when the weights sum to zero — widths would be fabrication", () => {
    const html = render([
      { label: "a", pct: 0 }, { label: "b", pct: 0 }, { label: "c", pct: 0 },
    ]);
    expect(html).not.toContain("width:");
    expect(html).toContain("a 0%");        // the parsed claim still shows as text
  });

  it("draws no bar for more scenarios than validated colour slots", () => {
    const html = render([
      { label: "a", pct: 25 }, { label: "b", pct: 25 },
      { label: "c", pct: 25 }, { label: "d", pct: 25 },
    ]);
    expect(html).not.toContain("var(--viz-");   // no 4th hue, no cycling
    expect(html).toContain("d 25%");            // the split survives as text
  });

  it("renders nothing at all for an empty list", () => {
    expect(render([])).toBe("");
  });
});
