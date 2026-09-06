import { expect, test } from "@playwright/test";

/**
 * The reference desk's LIVE path, exercised hermetically.
 *
 * smoke.spec.ts and mobile.spec.ts block both TradingView hosts outright, so
 * every other test in the suite sees /markets in its "could not be loaded"
 * state — which is the state that has to hold when the desk is offline, and
 * worth covering, but it means the upgrade path goes untested. A widget that
 * never loads and a widget that loads but never retires its placeholder look
 * identical to a suite that only ever sees the former.
 *
 * So this file fulfils the widget requests LOCALLY. Nothing leaves the
 * machine — Playwright answers every TradingView URL from the stubs below —
 * so the suite stays hermetic while still exercising both mounting shells in
 * components/tradingview-embed.tsx.
 *
 * Two shells means two stubs, because readiness is detected differently for
 * each (lib/tradingview.ts explains why both generations are in play):
 *
 *   - the web components (watchlist, world market summary, seasonal chart)
 *     resolve on `customElements.whenDefined`, so their stub is an ES module
 *     that defines the element;
 *   - the classic embeds (heatmap, screener, news) are scripts that inject an
 *     iframe, and the shell flips to "live" on the widget's own postMessage
 *     from a TradingView origin — so that stub injects an iframe pointing at
 *     a TradingView-widget URL, and THAT document (also fulfilled locally)
 *     posts the message. The origin check is exercised for real rather than
 *     bypassed.
 */

/** Defines one custom element the way TradingView's module does. */
const componentModule = (tag: string) => `
  class Stub extends HTMLElement {
    connectedCallback() {
      this.style.display = "block";
      this.dataset.stub = "${tag}";
      this.textContent = this.getAttribute("symbol-sectors")
        ?? this.getAttribute("symbol") ?? this.getAttribute("view") ?? "";
    }
  }
  customElements.define("${tag}", Stub);
`;

/** Injects the iframe a classic embed script injects. */
const CLASSIC_SCRIPT = `
  (function () {
    var self = document.currentScript;
    var host = self && self.parentElement;
    if (!host) return;
    var frame = document.createElement("iframe");
    frame.title = "stub reference widget";
    frame.src = "https://www.tradingview-widget.com/stub-reference";
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.border = "0";
    host.appendChild(frame);
  })();
`;

const CLASSIC_FRAME = `<!doctype html><meta charset="utf-8">
  <body style="margin:0">
  <script>parent.postMessage({ name: "tv-widget-load" }, "*");<\/script>`;

const COMPONENTS = ["tv-market-data", "tv-world-market-summary", "tv-seasonal-chart"];

test.beforeEach(async ({ page }) => {
  // ORDER IS LOAD-BEARING. Playwright matches handlers in REVERSE
  // registration order — the last registered wins — so the catch-all
  // refusals go on FIRST and the specific stubs on top of them. The
  // catch-alls are the safety net: anything TradingView-shaped that no stub
  // claims is refused, so a stub whose URL drifts fails loudly here instead
  // of quietly reaching the internet.
  await page.route("**://*.tradingview.com/**", route => route.abort());
  await page.route("**://*.tradingview-widget.com/**", route => route.abort());

  for (const tag of COMPONENTS) {
    await page.route(
      `**://widgets.tradingview-widget.com/w/en/${tag}.js`,
      route => route.fulfill({ contentType: "text/javascript", body: componentModule(tag) }));
  }
  await page.route(
    "**://s3.tradingview.com/external-embedding/embed-widget-*.js",
    route => route.fulfill({ contentType: "text/javascript", body: CLASSIC_SCRIPT }));
  // Exact host: widgets.* and www.* are both under tradingview-widget.com and
  // must not fall through to each other's handler.
  await page.route(
    "**://www.tradingview-widget.com/**",
    route => route.fulfill({ contentType: "text/html", body: CLASSIC_FRAME }));
});

/**
 * Region name -> the element that proves that card's widget mounted. Three
 * web components, then three classic embeds, in the page's own order.
 */
const CARDS: [string, string][] = [
  ["Watchlist — gold and its drivers", "tv-market-data"],
  ["Gold seasonality", "tv-seasonal-chart"],
  ["World market summary", "tv-world-market-summary"],
  ["S&P 500 heatmap", 'iframe[title="stub reference widget"]'],
  ["FX screener", 'iframe[title="stub reference widget"]'],
  ["TradingView gold commentary", 'iframe[title="stub reference widget"]'],
];

test("the reference desk mounts both widget generations", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto("/markets");

  // The watchlist is above the fold and is the page's reason to exist, so it
  // mounts without being asked.
  const watchlist = page.getByRole("region", { name: CARDS[0][0] });
  await expect(watchlist.locator(CARDS[0][1])).toHaveCount(1);

  // Nothing below it has loaded, and that is the assertion that protects this
  // page's whole performance budget: six third-party widgets behind an
  // IntersectionObserver, so a reader who never scrolls pays for one.
  await expect(page.locator("tv-seasonal-chart")).toHaveCount(0);
  await expect(page.locator('iframe[title="stub reference widget"]')).toHaveCount(0);

  // Then walk the page one card at a time. Deliberately not a single jump to
  // the bottom: an IntersectionObserver only reports what is intersecting
  // when it delivers, so scrolling straight past the middle cards would leave
  // them never armed — which is the gate behaving correctly, and would make a
  // bottom-scroll test look like a mounting bug.
  for (const [name, selector] of CARDS.slice(1)) {
    const region = page.getByRole("region", { name });
    await region.scrollIntoViewIfNeeded();
    await expect(region.locator(selector), `${name} never mounted`).toHaveCount(1);
  }

  // Heatmap, screener and news: three classic embeds, three stub iframes.
  await expect(page.locator('iframe[title="stub reference widget"]')).toHaveCount(3);

  expect(errors).toEqual([]);
});

test("the watchlist carries Jamasp's themes, not TradingView's defaults", async ({ page }) => {
  await page.goto("/markets");
  const el = page.locator("tv-market-data");
  const sectors = await el.getAttribute("symbol-sectors");
  expect(sectors).toBeTruthy();

  // The sections are Jamasp's own map-theme vocabulary (config/weights.yaml),
  // which is what lets a reader carry a finding from the market map to this
  // table. TradingView's starter list must never survive into ours.
  expect(sectors).toContain("Gold complex");
  expect(sectors).toContain("Rates & dollar");
  expect(sectors).toContain("FX_IDC:XAUUSD");
  expect(sectors).not.toContain("NASDAQ:AAPL");

  // The count is the test: a regression that substituted a nominal yield for
  // the missing REAL yield, or found a symbol for gold vol, would change it.
  const parsed = JSON.parse(sectors!) as { symbols: string[] }[];
  expect(parsed.flatMap(s => s.symbols)).toHaveLength(20);
  expect(sectors).not.toContain("DFII10");
  expect(sectors).not.toContain("GVZ");
});

test("the page never lets a TradingView widget pass as Jamasp's own read", async ({ page }) => {
  await page.goto("/markets");
  // Provenance is not decoration here — it is the reason this is a separate
  // route at all. Every card says whose data it is, and the page says it
  // twice more: once in the subtitle and once in the banner.
  // Apostrophes here are U+2019, not ASCII: the page writes `&rsquo;`, and a
  // regex with a straight quote silently matches nothing.
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Markets");
  await expect(page.getByText(/not Jamasp's analysis/)).toBeVisible();
  await expect(page.getByText(/TradingView’s data and\s+TradingView’s framing/))
    .toBeVisible();
  await expect(page.getByText(/Source: TradingView, live\./).first()).toBeVisible();

  // The refusal is stated on the page, not just in a code comment: a reader
  // who wonders where the buy/sell gauge is gets an answer.
  await expect(page.getByText(/Strong sell \/ Sell \/ Neutral \/ Buy \/ Strong buy/))
    .toBeVisible();
});

test("the economic calendar sits under Jamasp's own list, not instead of it", async ({ page }) => {
  await page.goto("/calendar");

  // Jamasp's events come FIRST and are labelled as what it is watching; the
  // widget is explicitly reference. docs/todo/001 is why both exist: the
  // ff_calendar source ships one week at a time, so Jamasp's horizon ends at
  // the end of the current week and the widget sees past that edge.
  const jamasp = page.getByRole("region", { name: "What Jamasp is watching" });
  const reference = page.getByRole("region", { name: "TradingView economic calendar" });
  await expect(jamasp).toBeVisible();
  await expect(reference).toBeVisible();

  const jamaspBox = await jamasp.boundingBox();
  const referenceBox = await reference.boundingBox();
  expect(jamaspBox!.y, "the reference calendar must not outrank Jamasp's own")
    .toBeLessThan(referenceBox!.y);

  await reference.scrollIntoViewIfNeeded();
  await expect(reference.locator('iframe[title="stub reference widget"]')).toHaveCount(1);
});
