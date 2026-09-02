import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Figure } from "@/components/ui/figure";

describe("Figure", () => {
  it("formats with thousands separators and fixed digits", () => {
    const html = renderToStaticMarkup(<Figure value={4401.3} digits={2} />);
    expect(html).toContain("4,401.30");
  });

  it("uses tabular figures so columns align", () => {
    expect(renderToStaticMarkup(<Figure value={1} />)).toContain("tabular-nums");
  });

  // The honest-null contract: a missing value is stated, never rendered as
  // zero. Fabricating a flat zero is the specific failure this guards.
  it("renders the empty text for a null value", () => {
    const html = renderToStaticMarkup(<Figure value={null} empty="no data" />);
    expect(html).toContain("no data");
    expect(html).not.toContain("0");
  });

  it("defaults the empty text rather than rendering nothing", () => {
    expect(renderToStaticMarkup(<Figure value={null} />)).toContain("—");
  });

  it("renders a real zero when the value genuinely is zero", () => {
    expect(renderToStaticMarkup(<Figure value={0} digits={2} />)).toContain("0.00");
  });

  it("renders label and sub text when supplied", () => {
    const html = renderToStaticMarkup(
      <Figure value={58.4} digits={1} label="RSI 14" sub="2m old" />);
    expect(html).toContain("RSI 14");
    expect(html).toContain("2m old");
  });
});
