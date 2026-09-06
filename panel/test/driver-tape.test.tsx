import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DriverTape } from "../components/driver-tape";
import { deriveDriver, DRIVER_SPECS } from "../lib/drivers";
import { TV_TICKER_TAPE_HEIGHT } from "../lib/tradingview";

// No clock: the band prints values and changes, never an age. That is the
// difference between it and the Drivers card — a glance strip has no room
// for provenance, so it makes no freshness claim to be wrong about.
const quote = (value: number) => ({ ts: "2026-08-11T09:00:00Z", value });

const populated = DRIVER_SPECS.map((spec, i) => deriveDriver(spec, quote(100 + i), 99 + i, []));
const empty = DRIVER_SPECS.map(spec => deriveDriver(spec, null, null, []));

describe("DriverTape", () => {
  /**
   * The band is above the fold, which makes its server render the panel's
   * first paint. Every assertion here is about what a reader sees in the
   * window between that paint and the embed arriving — a window that never
   * closes at all when TradingView is blocked, offline or down.
   */
  it("puts Jamasp's own readings in the band at first paint", () => {
    const html = renderToStaticMarkup(<DriverTape drivers={populated} />);
    expect(html).toContain("DXY");
    expect(html).toContain("100");
    expect(html).toContain("BTC");
    // The widget renders nothing on the server, so this markup IS the strip
    // until the module loads. It must never be an empty box.
    expect(html).not.toContain("tv-ticker-tape");
  });

  it("carries the same drivers as the tape, so the swap is like for like", () => {
    // A fallback listing six readings that became five when the embed landed
    // would make gold's dominant driver look like something that flickers.
    // The band shows the quotable five in both states; the real yield gets a
    // labelled tile in the Drivers card instead.
    const html = renderToStaticMarkup(<DriverTape drivers={populated} />);
    expect(html).not.toContain("US 10y real");
    expect(html).toContain("US 10y");
  });

  it("reserves the widget's own height, so nothing moves when it arrives", () => {
    const html = renderToStaticMarkup(<DriverTape drivers={populated} />);
    expect(html).toContain(`height:${TV_TICKER_TAPE_HEIGHT}px`);
  });

  it("dashes an absent reading rather than inventing one", () => {
    const html = renderToStaticMarkup(<DriverTape drivers={empty} />);
    expect(html).toContain("—");
    // No value means no change claim either: an absent quote must not pick
    // up a delta slot, and nothing here may render the fabricated flat zero
    // the overview E2E forbids.
    expect(html).not.toContain("= 0");
    expect(html).not.toContain("0.00%");
  });

  it("keeps the honest 24h dash on a frozen feed", () => {
    const frozen = [deriveDriver(DRIVER_SPECS[0], quote(103.8), null, [])];
    const html = renderToStaticMarkup(<DriverTape drivers={frozen} />);
    expect(html).toContain("103.8");
    expect(html).toContain("—");
  });

  it("renders no band at all when no driver has a live symbol", () => {
    // An empty 48px rule across the top of the page would be worse than
    // nothing — the one case where collapsing is the honest answer.
    const real = DRIVER_SPECS.filter(s => s.symbol === "DFII10")
      .map(s => deriveDriver(s, quote(2.42), 2.4, []));
    expect(renderToStaticMarkup(<DriverTape drivers={real} />)).toBe("");
    expect(renderToStaticMarkup(<DriverTape drivers={[]} />)).toBe("");
  });
});
