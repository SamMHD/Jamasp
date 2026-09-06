import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DriverPanel } from "../components/driver-panel";
import { deriveDriver, DRIVER_SPECS } from "../lib/drivers";

const NOW = new Date("2026-08-11T12:00:00Z");

describe("DriverPanel", () => {
  it("renders a tile per configured driver, populated and absent alike", () => {
    const drivers = DRIVER_SPECS.map((spec, i) =>
      i === 0
        ? deriveDriver(spec, { ts: "2026-08-10T03:06:09Z", value: 99.71 }, 100.21, [])
        : deriveDriver(spec, null, null, []));
    const html = renderToStaticMarkup(<DriverPanel drivers={drivers} now={NOW} />);
    expect(html).toContain("DXY");
    expect(html).toContain("99.71");
    expect(html).toContain("▼ 0.5");
    expect(html).toContain("US 10y real");
    // five of six have no rows; each states it rather than hiding the tile
    expect(html.match(/no data/g)).toHaveLength(5);
  });

  it("shows the honest unknown-dash on a frozen driver feed", () => {
    const drivers = [deriveDriver(DRIVER_SPECS[0],
      { ts: "2026-08-10T03:06:09Z", value: 99.71 }, null, [])];
    const html = renderToStaticMarkup(<DriverPanel drivers={drivers} now={NOW} />);
    expect(html).toContain("24h —");
    expect(html).not.toContain("= 0");
  });

  it("renders the driver with no widget last, where DRIVER_SPECS puts it", () => {
    // The card holds no ordering of its own — it iterates the specs. This
    // pins that it stays that way: a JSX-level sort would drift the moment
    // someone edited lib/drivers.ts and nothing here would notice.
    const drivers = DRIVER_SPECS.map(spec => deriveDriver(spec, null, null, []));
    const html = renderToStaticMarkup(<DriverPanel drivers={drivers} now={NOW} />);
    // `&` in "S&P 500" arrives escaped in the markup.
    const positions = drivers.map(d => html.indexOf(d.label.replace("&", "&amp;")));
    expect(positions.every(p => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html.indexOf("US 10y real")).toBe(Math.max(...positions));
  });

  it("attributes the tile that has no widget instead of leaving it bare", () => {
    // The defect this fixes: a tile with neither logo nor chart, sitting
    // between two that had both, read as the embed that failed. It now
    // carries the same "jamasp" provenance word the live tiles print under
    // their widgets, so the card is one family with one convention.
    const real = DRIVER_SPECS.find(s => s.symbol === "DFII10")!;
    const html = renderToStaticMarkup(
      <DriverPanel now={NOW}
        drivers={[deriveDriver(real, { ts: "2026-08-11T09:00:00Z", value: 2.42 }, 2.4, [])]} />);
    expect(html).toContain("2.42");
    expect(html).toContain("jamasp");
  });

  it("captions the mixed card, and only while it is mixed", () => {
    // Derived from the data, not written into the JSX: remove the last
    // driver with no TradingView equivalent and the sentence explaining the
    // absence goes with it, rather than staying to explain nothing.
    const mixed = renderToStaticMarkup(
      <DriverPanel drivers={DRIVER_SPECS.map(s => deriveDriver(s, null, null, []))} now={NOW} />);
    expect(mixed).toContain("Real yield is Jamasp");
    expect(mixed).toContain("TIPS");

    const allLive = renderToStaticMarkup(
      <DriverPanel now={NOW}
        drivers={DRIVER_SPECS.filter(s => s.symbol !== "DFII10")
          .map(s => deriveDriver(s, null, null, []))} />);
    expect(allLive).not.toContain("Real yield is Jamasp");
  });
});
