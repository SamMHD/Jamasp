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
});
