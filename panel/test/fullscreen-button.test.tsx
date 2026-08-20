import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FullscreenButton } from "../components/fullscreen-button";

describe("FullscreenButton", () => {
  it("renders a real button, not a div with a handler", () => {
    const html = renderToStaticMarkup(<FullscreenButton targetId="market-map" />);
    expect(html).toMatch(/<button/);
    expect(html).toContain('type="button"');
  });

  it("names what it does for a screen reader", () => {
    // The control is an icon-and-short-label affair; without an explicit
    // label its purpose is conveyed by a glyph alone.
    const html = renderToStaticMarkup(<FullscreenButton targetId="market-map" />);
    expect(html).toMatch(/aria-label="[^"]+"/i);
    expect(html.toLowerCase()).toContain("full screen");
  });

  it("renders on the server without touching browser globals", () => {
    // It is a client component, but it still server-renders as part of the
    // page. Reaching for `document` during render would throw here — which is
    // exactly what this asserts does not happen.
    expect(() => renderToStaticMarkup(
      <FullscreenButton targetId="market-map" />)).not.toThrow();
  });
});
