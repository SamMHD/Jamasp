import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FullscreenButton } from "../components/fullscreen-button";
import { getMessages } from "../lib/i18n";
import en from "../messages/en.json";
import fa from "../messages/fa.json";

const messages = { en: en as Record<string, string>, fa: fa as Record<string, string> };

describe("FullscreenButton", () => {
  it("renders a real button, not a div with a handler", () => {
    const html = renderToStaticMarkup(
      <FullscreenButton targetId="market-map" messages={getMessages("en")} />);
    expect(html).toMatch(/<button/);
    expect(html).toContain('type="button"');
  });

  it("names what it does for a screen reader", () => {
    // The control is an icon-and-short-label affair; without an explicit
    // label its purpose is conveyed by a glyph alone.
    const html = renderToStaticMarkup(
      <FullscreenButton targetId="market-map" messages={getMessages("en")} />);
    expect(html).toMatch(/aria-label="[^"]+"/i);
    expect(html.toLowerCase()).toContain("full screen");
  });

  it("renders on the server without touching browser globals", () => {
    // It is a client component, but it still server-renders as part of the
    // page. Reaching for `document` during render would throw here — which is
    // exactly what this asserts does not happen.
    expect(() => renderToStaticMarkup(
      <FullscreenButton targetId="market-map" messages={getMessages("en")} />)).not.toThrow();
  });

  // The whole control — visible label, aria-label and title — was English in
  // both locales, inside MarketMap and TechnicalMap, which are the two
  // busiest surfaces on the overview.
  it("translates the visible label, the aria-label and the title together", () => {
    const html = renderToStaticMarkup(
      <FullscreenButton targetId="market-map" messages={messages.fa} />);
    const label = messages.fa["common.fullScreen"];
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`title="${label}"`);
    expect(html).toContain(`>${label}<`);
    expect(html.toLowerCase()).not.toContain("full screen");
  });

  it("takes both labels from the dictionary, not a hard-coded English pair", () => {
    // The exit label only appears after a fullscreenchange event, which a
    // static render never fires — so it is asserted at the dictionary, which
    // is the thing that could silently go missing. The component reads both
    // through the same t() call shape.
    expect(messages.fa["common.exitFullScreen"].trim()).not.toBe("");
    expect(messages.fa["common.exitFullScreen"]).not.toBe(messages.en["common.exitFullScreen"]);
  });
});
