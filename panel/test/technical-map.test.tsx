import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TechnicalMap } from "@/components/technical-map";
import type { SignalTile } from "@/lib/technicalmap";

const tile = (over: Partial<SignalTile> = {}): SignalTile => ({
  key: "rsi14@1d", signal: "rsi14", timeframe: "1d", family: "momentum",
  state: 0.8, ts: "2026-08-20T00:00:00Z", multiplier: 2, fitted: true,
  pinned: false, source: "bars", ...over,
});

const render = (tiles: SignalTile[]) =>
  renderToStaticMarkup(
    <TechnicalMap tiles={tiles} width={1200} height={600}
      fittedAt="2026-08-20T04:17:00Z" />);

describe("TechnicalMap", () => {
  it("renders a tile per signal, grouped by family", () => {
    const html = render([tile(), tile({ key: "sma50@1d", signal: "sma50",
      family: "trend", state: -0.9 })]);
    expect(html).toContain("rsi14");
    expect(html).toContain("sma50");
    expect(html).toContain("Momentum");
    expect(html).toContain("Trend");
  });

  it("hatches BOTH bearish tones, never just the pole", () => {
    // bear (state -0.9) and bear-mid (state -0.3) must each carry the hatch:
    // bear/bull-mid fails at dE 2.8 for protanopes and bear-mid/bull-mid at
    // dE 3.1 for deuteranopes, so hatching only the pole silently
    // reintroduces both failures.
    const html = render([
      tile({ key: "a@1d", signal: "a", state: -0.9 }),
      tile({ key: "b@1d", signal: "b", state: -0.3 }),
    ]);
    expect(html.match(/url\(#map-hatch\)/g) ?? []).toHaveLength(2);
  });

  it("does not hatch bullish or neutral tiles", () => {
    const html = render([
      tile({ key: "a@1d", state: 0.9 }),
      tile({ key: "b@1d", state: 0.05 }),
    ]);
    expect(html).not.toContain("url(#map-hatch)");
  });

  it("draws an unfitted tile with a dashed outline", () => {
    // Before the first fit every multiplier is 1.0 and the map is a uniform
    // grid. Dashed is what stops that grid reading as a measurement.
    expect(render([tile({ fitted: false, multiplier: 1 })]))
      .toContain("stroke-dasharray");
  });

  it("draws a fitted tile solid", () => {
    expect(render([tile({ fitted: true })])).not.toContain("stroke-dasharray");
  });

  it("draws a pinned-but-unfitted tile solid, not dashed", () => {
    // Dashed means "1.0 for want of a sample" -- a pin is not that. It is a
    // human's deliberate number, exactly as real as a fitted one, so it
    // must render solid even though `fitted` is false. A retro reaches for
    // a pin precisely for the columns short of min_observations, so this
    // is the exact case the pin exists to fix.
    const html = render([tile({ fitted: false, pinned: true, multiplier: 2.5 })]);
    expect(html).not.toContain("stroke-dasharray");
  });

  it("still dashes a tile that is neither fitted nor pinned", () => {
    const html = render([tile({ fitted: false, pinned: false, multiplier: 1 })]);
    expect(html).toContain("stroke-dasharray");
  });

  it("marks a pinned tile's weight as pinned in its hover title", () => {
    const html = render([tile({ fitted: false, pinned: true, multiplier: 2.5 })]);
    expect(html).toContain("pinned");
    expect(html).toContain("2.50");
  });

  it("states each signal's read and multiplier in its hover title", () => {
    expect(render([tile()])).toContain("rsi14 1d");
    expect(render([tile()])).toContain("2.00");
  });

  it("shows an honest empty state with no tiles at all", () => {
    const html = render([]);
    expect(html).toContain("No technical signals");
    expect(html).not.toContain("<svg");
  });

  it("renders the hatch pattern definition in its own svg", () => {
    // A url(#map-hatch) reference into an SVG with no such pattern paints
    // nothing, silently removing the second encoding.
    expect(render([tile({ state: -0.9 })])).toContain('id="map-hatch"');
  });
});

it("names TradingView provenance in the hover title, and only then", () => {
  // A bar-computed state is the normal path and says nothing; a state read
  // off TradingView is a real reading from somewhere else and says so.
  expect(render([tile({ source: "tradingview" })])).toContain("via TradingView");
  expect(render([tile({ source: "bars" })])).not.toContain("via TradingView");
});
