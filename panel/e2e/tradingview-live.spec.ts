import { expect, test } from "@playwright/test";

/**
 * The LIVE half of the TradingView integration.
 *
 * smoke.spec.ts and mobile.spec.ts block both widget hosts outright, so every
 * other test in this suite runs the fallback path — the one that has to hold
 * when the desk is offline or TradingView is down. That leaves the upgrade
 * path itself untested, which is the half that actually changed: a widget
 * that never loads and a widget that loads but never retires the fallback
 * look identical to a suite that only ever sees the former.
 *
 * So this file fulfils the widget requests LOCALLY instead of aborting them.
 * Nothing leaves the machine — Playwright answers every TradingView URL from
 * the stubs below — so the suite stays hermetic while still exercising the
 * live branch of both components.
 *
 * Two widget generations means two stubs, because the panel detects
 * readiness differently for each (lib/tradingview.ts explains why both
 * widgets exist):
 *
 *   - Mini Chart (Drivers card) is a web component. components/
 *     tradingview-mini-chart.tsx resolves on `customElements.whenDefined`,
 *     so the stub is an ES module that defines the element.
 *   - Advanced Chart (Technical card) is a classic embed script that injects
 *     an iframe. components/live-chart.tsx flips to "live" on the widget's
 *     own `postMessage` from a TradingView origin — so the stub script
 *     injects an iframe pointing at a TradingView-widget URL, and THAT
 *     document (also fulfilled locally) posts the message. The origin check
 *     in live-chart.tsx is therefore exercised for real rather than bypassed.
 */

/** Defines <tv-mini-chart> the way TradingView's module does. */
const MINI_CHART_MODULE = `
  class StubMiniChart extends HTMLElement {
    connectedCallback() {
      this.style.display = "block";
      this.dataset.stub = "mini-chart";
      this.textContent = this.getAttribute("symbol") ?? "";
    }
  }
  customElements.define("tv-mini-chart", StubMiniChart);
`;

/**
 * Defines <tv-ticker-tape>, the overview's band. A separate module from the
 * Mini Chart's on purpose — that is how TradingView ships them, and
 * components/tv-widget.tsx keys its loader singleton on the script URL, so a
 * shared stub would hide a real failure mode: two tags served by one module
 * where only the first is ever defined.
 */
const TICKER_TAPE_MODULE = `
  class StubTickerTape extends HTMLElement {
    connectedCallback() {
      this.style.display = "block";
      this.dataset.stub = "ticker-tape";
      this.textContent = this.getAttribute("symbols") ?? "";
    }
  }
  customElements.define("tv-ticker-tape", StubTickerTape);
`;

/** Injects the iframe the Advanced Chart embed script injects. */
const ADVANCED_CHART_SCRIPT = `
  (function () {
    var self = document.currentScript;
    var host = self && self.parentElement;
    if (!host) return;
    var frame = document.createElement("iframe");
    frame.title = "stub advanced chart";
    frame.src = "https://www.tradingview-widget.com/stub-advanced-chart";
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.border = "0";
    host.appendChild(frame);
  })();
`;

/**
 * The widget's readiness signal. live-chart.tsx only accepts it from a
 * TradingView origin, and this document is served as one.
 */
const ADVANCED_CHART_FRAME = `<!doctype html><meta charset="utf-8">
  <body style="margin:0">
  <script>parent.postMessage({ name: "tv-widget-load" }, "*");<\/script>`;

test.beforeEach(async ({ page }) => {
  // ORDER IS LOAD-BEARING. Playwright matches handlers in REVERSE
  // registration order — the last route registered wins — so the catch-all
  // refusals go on FIRST and the specific stubs on top of them. Registered
  // the other way round, the wildcards shadow every stub and both tests here
  // silently assert the fallback path the rest of the suite already covers.
  //
  // The catch-alls are the safety net: anything TradingView-shaped that no
  // stub below claims is refused, so a stub whose URL drifts fails loudly
  // here instead of quietly reaching the internet and making this suite
  // depend on someone else's uptime.
  await page.route("**://*.tradingview.com/**", route => route.abort());
  await page.route("**://*.tradingview-widget.com/**", route => route.abort());

  // Exact hosts, no wildcards: widgets.* and www.* are both under
  // tradingview-widget.com and must not fall through to each other's handler.
  await page.route(
    "**://widgets.tradingview-widget.com/w/en/tv-mini-chart.js",
    route => route.fulfill({ contentType: "text/javascript", body: MINI_CHART_MODULE }));
  await page.route(
    "**://widgets.tradingview-widget.com/w/en/tv-ticker-tape.js",
    route => route.fulfill({ contentType: "text/javascript", body: TICKER_TAPE_MODULE }));
  await page.route(
    "**://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js",
    route => route.fulfill({ contentType: "text/javascript", body: ADVANCED_CHART_SCRIPT }));
  await page.route(
    "**://www.tradingview-widget.com/**",
    route => route.fulfill({ contentType: "text/html", body: ADVANCED_CHART_FRAME }));
});

test("the technical chart upgrades to the live widget", async ({ page }) => {
  await page.goto("/");
  const technical = page.getByRole("region", { name: "Technical", exact: true });

  // The caption is the component's own verdict, and it is the assertion that
  // matters: "live" means LiveChart positively confirmed a widget rather than
  // merely mounting an iframe and hoping. It names the instrument and the
  // resolved symbol, both of which come from lib/tradingview.ts.
  await expect(technical.getByText(/^live · spot XAU\/USD · FX_IDC:XAUUSD/))
    .toBeVisible();
  await expect(technical.locator('iframe[title="stub advanced chart"]')).toBeVisible();

  // The stored series stays reachable in the live case: the widget is a
  // cross-origin iframe whose numbers cannot be read off the page, so the
  // disclosure is the desk's only route to Jamasp's own figures.
  await expect(technical.getByText(/stored readings as table/)).toBeVisible();
  // And the basis note stays put — the widget charts spot, Jamasp reads the
  // front-month future, and that standing gap must never read as staleness.
  await expect(technical.getByText(/carry premium/)).toBeVisible();
});

test("the driver tiles upgrade to live mini charts, except the real yield", async ({ page }) => {
  await page.goto("/");
  const drivers = page.getByRole("region", { name: "Drivers" });
  // The card sits below the fold and the embeds are gated on an
  // IntersectionObserver, so nothing loads until it is actually scrolled to.
  await drivers.scrollIntoViewIfNeeded();

  // Five of the six drivers have a verified TradingView symbol. The sixth is
  // the 10-year REAL yield, which has none — see lib/tradingview.ts. That the
  // count is five and not six IS the test: a regression that substituted a
  // nominal yield for the real one would show up here as a sixth widget.
  await expect(drivers.locator("tv-mini-chart")).toHaveCount(5);
  await expect(drivers.locator('tv-mini-chart:text("PEPPERSTONE:USDX")')).toHaveCount(1);

  // The real-yield tile is untouched, still showing Jamasp's own label.
  await expect(drivers.getByText("US 10y real")).toBeVisible();

  // A live tile keeps Jamasp's reading underneath as an attributed footer:
  // the widget states change as a percent and carries no age, so the absolute
  // 24h move and the provenance line the card was built around stay on
  // screen. DXY is the driver the fixture has data for.
  await expect(drivers.getByText(/jamasp 103\.8/)).toBeVisible();
});

test("the ticker tape upgrades in place, without moving the page", async ({ page }) => {
  await page.goto("/");
  const tape = page.getByRole("region", { name: "Driver tape" });

  // The band is the one embed on this panel that is on screen at first paint,
  // so it is gated on the main thread going quiet rather than on the viewport
  // — no scroll here, on purpose. It must arrive anyway.
  const widget = tape.locator("tv-ticker-tape");
  await expect(widget).toHaveCount(1);

  // Five symbols, comma-separated: the attribute shape the widget's own
  // converter expects (a JSON array parses as one nonsense ticker and renders
  // an empty band), and the drivers card's line-up in the drivers card's
  // order. The real yield is absent here for the same reason it has no Mini
  // Chart, and a regression substituting a nominal yield would show up as a
  // sixth entry.
  const symbols = (await widget.textContent())!.split(",");
  expect(symbols).toEqual(
    ["PEPPERSTONE:USDX", "PYTH:US10Y", "FX:USDJPY", "SPREADEX:SPX", "BITSTAMP:BTCUSD"]);

  // The reason this test exists at all: the band is ABOVE the fold, so an
  // embed that added height rather than landing in the reserved box would
  // shove the entire overview down under the reader. Its height is the same
  // 48px it holds in smoke.spec.ts, where the widget never arrives.
  expect((await tape.boundingBox())!.height).toBe(48);

  // Jamasp's own readings are still in the DOM underneath, hidden rather than
  // unmounted, so the box stays reserved and a later failure has something to
  // fall back to.
  await expect(tape.getByText("103.8")).toBeHidden();
});
