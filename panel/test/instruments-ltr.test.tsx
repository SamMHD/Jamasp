import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Time runs left-to-right on a chart in Tehran as everywhere else, and these
 * components position directionally. Letting `rtl` inherit into them mirrors
 * axes and breaks layout for no reader's benefit.
 *
 * A source assertion rather than a render assertion because several of these
 * mount TradingView or a canvas and cannot be rendered in jsdom. It is
 * deliberately literal: it catches a component that loses its pin in a
 * refactor, which is the regression that matters.
 *
 * The mechanism differs by root element, and the assertion below follows it:
 * an HTML root (div/section/ol/...) is pinned with the `dir` attribute,
 * which the UA stylesheet turns into the `direction` property via a rule of
 * the form `[dir=ltr i] { direction: ltr; }` — but that stylesheet declares
 * an XHTML `@namespace`, and a compound selector with no type selector
 * carries an implied *universal* selector that the default namespace still
 * applies to (CSS Namespaces), so the rule matches only HTML-namespace
 * elements and never an SVG root. An SVG root is pinned directly with the
 * `direction` CSS property instead (`dir="ltr"` on an `<svg>` compiles fine
 * but does nothing).
 */
// "tradingview-embed" is deliberately not here: no components/tradingview-
// embed.tsx exists in this codebase (see components/tv-widget.tsx, which is
// the actual shared TradingView mounting machinery both tradingview-mini-
// chart.tsx and ticker-tape.tsx build on). Flagged rather than fabricated —
// see the task-6 report.
const HTML_ROOTED = [
  "market-map", "map-tiles", "technical-map", "live-chart", "spot-chart",
  "price-chart", "ticker-tape", "driver-tape", "level-ladder",
  "horizon-strip", "weight-bar", "tv-widget",
];

// These two root in an <svg>, where `dir` is inert — see the module comment.
const SVG_ROOTED = ["sparkline", "arc-gauge"];

function read(name: string): string {
  return fs.readFileSync(
    path.join(import.meta.dirname, "..", "components", `${name}.tsx`), "utf8");
}

describe("instrument components", () => {
  it.each(HTML_ROOTED)("%s pins itself LTR", name => {
    expect(read(name)).toContain('dir="ltr"');
  });

  it.each(SVG_ROOTED)("%s pins itself LTR via the direction property", name => {
    expect(read(name)).toContain('direction: "ltr"');
  });

  // tradingview-mini-chart.tsx renders no DOM node of its own — its entire
  // body is a single <TvWidget/> call, and TvWidget's host div is already
  // unconditionally pinned (asserted above, in HTML_ROOTED). Wrapping it in
  // an extra element purely to hold a redundant pin would be dead weight,
  // not defense in depth, so this checks the delegation itself: that the
  // component still hands off to TvWidget rather than growing its own
  // unpinned DOM node in a future refactor.
  it("tradingview-mini-chart delegates its pin to TvWidget", () => {
    expect(read("tradingview-mini-chart")).toMatch(/<TvWidget\b/);
  });
});
