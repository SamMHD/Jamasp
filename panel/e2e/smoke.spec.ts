import { expect, test } from "@playwright/test";

const ROUTES: [string, string][] = [
  ["/", "Overview"], ["/inbox", "Inbox"], ["/crawl", "Crawl"], ["/briefs", "Briefs"],
  ["/schedule", "Schedule"], ["/calendar", "Calendar"], ["/alerts", "Alerts"],
  ["/state", "State"], ["/prices", "Prices"],
];

for (const [path, title] of ROUTES) {
  test(`renders ${path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    const resp = await page.goto(path);
    expect(resp!.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(title);
    expect(errors).toEqual([]);
  });
}

test("brief reader renders fixture report", async ({ page }) => {
  await page.goto("/briefs/2026/07/2026-07-31-brief");
  await expect(page.getByText("Morning Brief")).toBeVisible();
});

test("overview renders the market instrument panels", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto("/");

  // Fundamental map: the hero, above everything else on the page. The
  // default (no ?w=) window is the trailing 24h, which only the fixture's
  // ~10-minutes-ago item (map1, rates_dollar, bullish) falls inside —
  // map2 is 3 days old. The wider window is checked in its own test below,
  // where both fixture items and the hatch path are in play.
  const map = page.getByRole("region", { name: "Market map" });
  await expect(page.getByRole("heading", { name: "Market map" })).toBeVisible();
  await expect(map.locator('svg[aria-label^="scored news treemap"]')).toBeVisible();
  await expect(map.getByText(/1 scored stor/)).toBeVisible();
  // The fixture's weights.json carries a technical-only fit — fitted_at is
  // set, but fits.theme does not exist at all. The footer must read this as
  // "not yet fitted" rather than announcing a rescale that never happened:
  // gating on the top-level timestamp alone (rather than on whether any
  // theme multiplier actually applied) would say "areas weighted" while
  // every theme is still at its neutral 1.0.
  await expect(map.getByText("weights not yet fitted")).toBeVisible();

  // Fundamental: heading, the weight bar's text legend, the falsifier rows
  // (condition split from consequence at the analyst's arrow — the
  // condition ends its own element), the watchlist chip, and the stance-age
  // amber (the fixture stance is dated 2026-08-01, permanently ≥2d old
  // against the real clock).
  const fundamental = page.getByRole("region", { name: "Fundamental" });
  await expect(page.getByRole("heading", { name: "Fundamental" })).toBeVisible();
  await expect(page.getByText("base 70%")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What flips me" })).toBeVisible();
  await expect(fundamental.getByText("A verified corridor text", { exact: true })).toBeVisible();
  await expect(fundamental.getByText("fed-rate-path")).toBeVisible();
  await expect(fundamental.getByText(/\d+d old/)).toBeVisible();

  // Horizon: the fixture's pending wakeup #1 (due 2026-08-02) is overdue
  // forever against the real clock, and both fixture predictions matured
  // before any future render — so these states are time-stable. The events
  // lane is deliberately not asserted here: the fixture's FOMC row drifts
  // in and out of the 7-day window as the calendar advances; populated
  // lanes are pinned with a fixed clock in horizon-strip.test.tsx.
  const horizon = page.getByRole("region", { name: "Horizon" });
  await expect(horizon.getByText("#1 deepdive")).toBeVisible();
  await expect(horizon.getByText("1 overdue")).toBeVisible();
  await expect(horizon.getByText("overdue", { exact: true })).toBeVisible();
  await expect(horizon.getByText("0 maturing")).toBeVisible();

  // News flow: the volume chart is anchored to the newest fixture item
  // (2026-08-01), so its window never empties as real time passes; the
  // headline list is cluster representatives — i3 is folded under i1 and
  // its headline must not appear; the feed age is stated unconditionally.
  const news = page.getByRole("region", { name: "News flow" });
  await expect(news.locator('svg[aria-label^="news volume"]')).toBeVisible();
  await expect(news.getByText("Latest headlines")).toBeVisible();
  await expect(news.getByText("Gold steadies as dollar slips")).toBeVisible();
  await expect(news.getByText("cnbc_finance").first()).toBeVisible();
  await expect(news.getByText(/last item/)).toBeVisible();
  await expect(page.getByText("Dollar slides on jobs data")).toHaveCount(0);

  // Technical: heading, the server-rendered spot chart, ladder rows, regime
  // line, and the RSI gauge with the fixture's exact reading in its name.
  //
  // exact: true on the region name — the technical map's own two sections
  // ("Technical map", "Technical signal treemap") both contain "Technical"
  // as a substring and would otherwise match too. The heading lookup is
  // scoped inside the exact-matched region for the same reason: unscoped,
  // "Technical" also matches this panel's own "Technical→ prices" heading
  // and the technical map's "Technical map" heading.
  const technical = page.getByRole("region", { name: "Technical", exact: true });
  await expect(technical.getByRole("heading")).toBeVisible();
  await expect(technical.locator('svg[aria-label^="gold futures"]')).toBeVisible();
  // Exact match: the stance prose itself contains "200DMA" as a substring
  // (in the View and What-flips-me bullets), which collides with a plain
  // substring getByText and produces a Playwright strict-mode violation.
  await expect(technical.getByText("200DMA", { exact: true })).toBeVisible();
  await expect(technical.getByText("pivot S1")).toBeVisible();
  await expect(technical.getByText("above 50DMA, below 200DMA")).toBeVisible();
  await expect(technical.locator('svg[aria-label="RSI14 58.4"]')).toBeVisible();

  // The fixture's newest GC bar is fixed at 2026-08-01, so the page is
  // permanently in the frozen-feed state — the 24h reference must be refused
  // rather than computed against the latest row itself. Both the GC hero and
  // the GVZ tile now honestly dash (`.first()` because several instruments
  // are frozen at once); the GC seam itself is pinned against this same
  // fixture database in spot-delta.test.tsx, and the fabricated-flat
  // renderings are asserted absent below.
  await expect(technical.getByText("24h —").first()).toBeVisible();
  await expect(page.getByText("0.00%")).toHaveCount(0);
  await expect(page.getByText("= 0")).toHaveCount(0);

  // Drivers: a populated tile (value + honest dash), a single-print tile,
  // and the four symbols with no fixture rows each stating "no data".
  const drivers = page.getByRole("region", { name: "Drivers" });
  await expect(drivers.getByText("DXY")).toBeVisible();
  await expect(drivers.getByText("103.8")).toBeVisible();
  await expect(drivers.getByText("4.29")).toBeVisible();
  await expect(drivers.getByText("no data")).toHaveCount(4);

  // Forecast record: hit rate over the decisive pair, full ledger counts,
  // the matured-unscored amber flag, and the calibration chart.
  const record = page.getByRole("region", { name: "Forecast record" });
  // .first(): the calibration chart's left axis label is also "50%" with
  // this fixture ledger; the hit-rate figure precedes it in the DOM.
  await expect(record.getByText("50%").first()).toBeVisible();
  await expect(record.getByText("hit rate · 2 decisive")).toBeVisible();
  await expect(record.getByText("1 hit · 1 miss · 1 unclear · 0 open")).toBeVisible();
  await expect(record.getByText("2 awaiting score")).toBeVisible();
  await expect(record.locator('svg[aria-label^="calibration"]')).toBeVisible();

  // The panel must never render a buy/sell verdict.
  await expect(page.getByText(/strong buy|strong sell|recommend/i)).toHaveCount(0);

  // Ops survives, demoted.
  await expect(page.getByText("runs")).toBeVisible();
  expect(errors).toEqual([]);
});

test("fundamental map's week window covers both fixture items and hatches the bearish one", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));

  // ?w=week widens the window enough to admit map2 (3 days old) alongside
  // map1 (10 minutes old) — two themes, and map2's direction=-2/conviction=0.8 is
  // the treemap's bearish pole, which must render hatched (market-map.tsx's
  // own tests pin why: colour alone is not compliant for two of the ramp's
  // ten step-pairs).
  await page.goto("/?w=week");
  const map = page.getByRole("region", { name: "Market map" });
  await expect(map.getByText(/2 scored stor/)).toBeVisible();
  await expect(map.getByText("Rates & dollar")).toBeVisible();
  await expect(map.getByText("Geopolitics")).toBeVisible();
  await expect(map.locator('svg[aria-label^="scored news treemap"] rect[fill="url(#map-hatch)"]'))
    .toHaveCount(1);

  // The window link itself is a plain, server-rendered <a>, not a client
  // toggle — confirms the page never needed "use client" for this.
  await expect(page.getByRole("link", { name: "This week" })).toHaveAttribute("aria-current", "page");

  expect(errors).toEqual([]);
});

test("overview renders the technical map", async ({ page }) => {
  await page.goto("/");
  const map = page.getByRole("img", { name: /technical signal treemap/ });
  await expect(map).toBeVisible();
  // The fixture holds one bearish signal, so exactly one tile must carry the
  // hatch — the assertion that would fail if the extraction into
  // map-tiles.tsx dropped the hatch on the way past.
  await expect(map.locator('rect[fill="url(#map-hatch)"]')).toHaveCount(1);
  // macd@1d has no fitted coefficient, so its tile must be dashed.
  await expect(map.locator("rect[stroke-dasharray]")).toHaveCount(1);
});
