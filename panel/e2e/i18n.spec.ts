import { expect, test } from "@playwright/test";
import en from "../messages/en.json";
import fa from "../messages/fa.json";

// Same convention as e2e/smoke.spec.ts: both TradingView embeds are blocked
// for the whole suite so this measures the panel's own i18n behaviour, never
// a third party's uptime.
test.beforeEach(async ({ page }) => {
  await page.route("**://*.tradingview-widget.com/**", route => route.abort());
  await page.route("**://*.tradingview.com/**", route => route.abort());
});

/**
 * components/lang-toggle.tsx's accessible name is `${glyph} — ${action}`,
 * where BOTH pieces render through the CURRENT locale's dictionary, not the
 * destination's — while the page is in English, the button reads "فا —
 * Switch to Persian" (the action phrase in English), and only once the page
 * is actually in Persian does that phrase itself switch to Persian too. So
 * the toggle is always found via the dictionary of the locale the page is
 * IN right now, never the one it is switching to.
 */
const switchToFaFromEnglish = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: en["lang.switchToFa"] });

test("defaults to English, left-to-right", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", "en");
  await expect(html).toHaveAttribute("dir", "ltr");
});

// The theme toggle's own e2e test (e2e/mobile.spec.ts, "the theme control
// cycles and persists") is the template: click, assert the attribute
// changed, reload, assert it survived — the locale cookie set by
// lib/actions.ts#setLocale (maxAge 1 year) is what makes the second half
// possible.
test("switching language flips <html> to Persian, right-to-left, and survives a reload", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", "en");

  await switchToFaFromEnglish(page).click();
  await expect(html).toHaveAttribute("lang", "fa");
  await expect(html).toHaveAttribute("dir", "rtl");

  await page.reload();
  await expect(html).toHaveAttribute("lang", "fa");
  await expect(html).toHaveAttribute("dir", "rtl");
});

test("an instrument stays left-to-right even while the page is right-to-left", async ({ page }) => {
  // Set the cookie via the toggle — the same mechanism the app itself uses
  // — rather than poking document.cookie: the lang cookie is httpOnly
  // (lib/actions.ts), so it can only be set through the real server action,
  // exactly as a reader would.
  await page.goto("/");
  await switchToFaFromEnglish(page).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // #market-map (components/market-map.tsx#MAP_ELEMENT_ID) is pinned
  // dir="ltr" on purpose: it draws a left-to-right time/window axis that a
  // mirrored RTL rendering would reverse for no reader's benefit. Asserting
  // the CSS `direction` property that dir="ltr" actually resolves to is
  // what proves the pin works, not just that the attribute is present in
  // markup (see components/arc-gauge.tsx's own note on why `dir` and
  // `direction` are not interchangeable for every element type).
  const direction = await page.locator("#market-map")
    .evaluate(el => getComputedStyle(el).direction);
  expect(direction).toBe("ltr");
});

test("the desktop nav renders Persian labels once switched", async ({ page }) => {
  await page.goto("/");
  await switchToFaFromEnglish(page).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "fa");

  // components/shell/side-nav.tsx — desktop-only (>=1024px), which this
  // project's "desktop" Playwright project (1440x900) always renders; see
  // e2e/mobile.spec.ts's identical "Sections" lookup for the counterpart
  // that only exists on the mobile project.
  const sections = page.getByRole("navigation", { name: "Sections" });
  await expect(sections.getByRole("link", { name: fa["nav.overview"] })).toBeVisible();
  await expect(sections.getByRole("link", { name: fa["nav.calendar"] })).toBeVisible();
  await expect(sections.getByRole("link", { name: fa["nav.predictions"] })).toBeVisible();
  // Never the raw English label leaking through instead of the translation.
  await expect(sections.getByRole("link", { name: "Overview", exact: true })).toHaveCount(0);
});

// test/fixtures/fixture.sql carries exactly one inbox item of each kind for
// this, both unread (InboxTable's default filter): i1 ("Gold steadies as
// dollar slips") has no headline_fa, i2 ("Fed officials split on September
// cut") does. /inbox has no forward-looking date window for a fixed 2026-08
// fixture date to drift out of the way the calendar's does, which is why
// this lives here rather than on /calendar. A real browser render is what
// proves the EN marker and the fallback text travel together, and that a
// translated row carries neither.
test("an untranslated row shows the EN marker; a translated one does not", async ({ page }) => {
  await page.goto("/inbox");
  await switchToFaFromEnglish(page).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "fa");

  const untranslatedRow = page.getByText("Gold steadies as dollar slips").locator("..");
  await expect(untranslatedRow.getByText(fa["content.sourceEnglish"], { exact: true }))
    .toBeVisible();

  const translatedRow = page.getByText("شکاف فدرال رزرو بر سر کاهش نرخ سپتامبر").locator("..");
  await expect(translatedRow.getByText(fa["content.sourceEnglish"], { exact: true }))
    .toHaveCount(0);
  // The English headline must not leak through under the translated row either.
  await expect(page.getByText("Fed officials split on September cut")).toHaveCount(0);
});
