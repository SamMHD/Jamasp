import { expect, test } from "@playwright/test";

const ROUTES = ["/", "/inbox", "/crawl", "/briefs", "/schedule",
                "/calendar", "/alerts", "/state", "/prices"];

for (const path of ROUTES) {
  test(`${path} fits the viewport`, async ({ page }) => {
    await page.goto(path);
    // The original failure mode: a fixed sidebar plus overflow-x-hidden on
    // main, which clipped content instead of scrolling it. A page wider than
    // its viewport is the symptom either way.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth,
      `${path} scrolls horizontally by ${overflow.scrollWidth - overflow.clientWidth}px`)
      .toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
}

test("primary navigation is the tab bar, not the sidebar", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeHidden();
});

test("every tab target clears 44px", async ({ page }) => {
  await page.goto("/");
  const tabs = page.getByRole("navigation", { name: "Primary" }).getByRole("link");
  const count = await tabs.count();
  expect(count).toBe(4);
  for (let i = 0; i < count; i++) {
    const box = await tabs.nth(i).boundingBox();
    expect(box, `tab ${i} has no box`).not.toBeNull();
    expect(box!.height, `tab ${i} is ${box!.height}px tall`).toBeGreaterThanOrEqual(44);
    expect(box!.width, `tab ${i} is ${box!.width}px wide`).toBeGreaterThanOrEqual(44);
  }
});

test("the More sheet reaches the overflow destinations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog");
  for (const label of ["Crawl", "Calendar", "Alerts", "State", "Prices"]) {
    await expect(sheet.getByRole("link", { name: label })).toBeVisible();
  }
});

test("the theme control cycles and persists", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const toggle = page.getByRole("button", { name: /^Appearance:/ });
  await toggle.click();                                   // system -> light
  await expect(html).toHaveClass(/light/);
  await toggle.click();                                   // light -> dark
  await expect(html).toHaveClass(/dark/);
  await page.reload();
  await expect(html).toHaveClass(/dark/);                 // survived the reload
});

test("Persian alerts render right-to-left in Vazirmatn", async ({ page }) => {
  await page.goto("/alerts");
  // The fixture's notify_log carries a Persian row (test/fixtures/fixture.sql)
  // — no `if (count > 0)` guard: if the fixture ever loses that row this test
  // must fail loudly, not silently no-op. It must be marked rtl so the
  // Vazirmatn binding in globals.css (`:where([dir="rtl"], [lang="fa"])`)
  // applies to it.
  const rtl = page.locator('[dir="rtl"]');
  await expect(rtl.first()).toBeVisible();

  // This branch's headline claim is that Persian text now renders in
  // Vazirmatn — self-hosted, requested for the first time — rather than
  // falling back to a generic sans-serif. Asserting `dir="rtl"` alone proves
  // the direction is right but says nothing about the font actually
  // resolving; the computed font-family is the only way to prove the
  // Vazirmatn `@font-face` — not just its CSS variable — is truly bound.
  const fontFamily = await rtl.first().evaluate(el => getComputedStyle(el).fontFamily);
  expect(fontFamily).toContain("Vazirmatn");
});

// --- Task 6 gap: the type scale's mobile step-up needs a live measurement ---
//
// test/type-scale.test.ts guards the *source* — the tokens must live in a
// plain `@theme` block, not `@theme inline`, or the mobile override in
// app/globals.css's `@layer base` changes a custom property no utility
// reads. But that test only inspects globals.css text; it cannot see
// whether the browser actually renders a bigger font at a phone width. This
// is the live proof: read the *computed* font-size of an element carrying a
// type-scale utility class at both widths — not the class name, which would
// stay "text-label" either way and prove nothing.
test("the type scale's mobile step-up is a real rendered increase", async ({ page }) => {
  await page.goto("/");
  // Any element on the page using a type-scale step works; .text-label
  // elements (QuoteTile's driver labels, in the Technical panel's
  // Drivers row) are always present and never display:none at any width,
  // so the same element handle can be measured at both viewports without
  // navigating away and losing it.
  const step = page.locator(".text-label").first();
  await expect(step).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopSize = await step.evaluate(el => parseFloat(getComputedStyle(el).fontSize));

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileSize = await step.evaluate(el => parseFloat(getComputedStyle(el).fontSize));

  expect(mobileSize, `mobile computed ${mobileSize}px vs desktop computed ${desktopSize}px — ` +
    "the mobile step-up (globals.css's max-width:63.999rem @layer base override) " +
    "must render strictly larger, not merely change a token nothing reads")
    .toBeGreaterThan(desktopSize);
});

// --- Task 11 gap: the tab bar's clearance has no regression test ---
//
// AppShell pads <main> by `calc(4rem + env(safe-area-inset-bottom))` — the
// same env() term the fixed TabBar itself pads with — because the bar's
// rendered height tracks that inset too (min-h-14 floor below it, growing
// past it above ~7px of inset). Measuring the two independently and
// comparing them is what proves the arithmetic still holds; anything else
// (asserting the class name, or a fixed pixel constant) would pass even if
// someone reverts to a flat pb-* that only happens to clear *this*
// environment's zero safe-area inset.
//
// This environment's browser reports a real `env(safe-area-inset-bottom)`
// of 0 by default, which is the trap: at 0 inset the bar sits at its
// `min-h-14` floor of 56px, and *both* the current `calc(4rem + 0) = 64px`
// fix and the original buggy flat `pb-20` (80px) clear that — so a test run
// at the default inset cannot tell the two apart, no matter how the
// assertion below is phrased. Task 11 found the real bug at the standard
// 34px iOS home-indicator inset, where the bar renders 83px and `pb-20`
// (80px) undershoots by 3px; only reproducing that inset can catch a
// regression to that shape. `page.context().newCDPSession` plus the
// experimental `Emulation.setSafeAreaInsetsOverride` command does that —
// confirmed working in this Chromium build (bar height 83px, `main`'s
// resolved padding-bottom 98px, matching the app-shell.tsx comment's
// numbers exactly) — so it is used here rather than accepting the 0-inset
// default.
test("page content is not occluded by the fixed tab bar", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34 } });

  await page.goto("/");
  // The tab bar is `position: fixed` and contributes no flex height, so the
  // only way to know whether the true last row of content clears it is to
  // scroll all the way down, the way a reader reaching the end of the page
  // would, and compare where things actually land.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  // The last direct child of the page's root element inside <main> — on the
  // Overview this is FooterStrip, the last thing rendered before main's own
  // bottom padding. Deliberately not <main> itself: main's own box already
  // includes that padding, so measuring main would just restate the padding
  // value rather than testing whether it is *enough*.
  const lastContent = page.locator("#main > div > *").last();
  const contentBox = await lastContent.boundingBox();
  const barBox = await page.getByRole("navigation", { name: "Primary" }).boundingBox();
  expect(contentBox, "no last content element found under #main").not.toBeNull();
  expect(barBox, "tab bar has no box").not.toBeNull();

  const contentBottom = contentBox!.y + contentBox!.height;
  expect(contentBottom,
    `last content bottom at ${contentBottom}px sits below the tab bar's top at ${barBox!.y}px — ` +
    "the bar's box model changed and main's bottom padding no longer clears it " +
    "(checked at a real 34px safe-area inset via CDP, not this environment's 0-inset default)")
    .toBeLessThanOrEqual(barBox!.y);
});
