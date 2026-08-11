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

test("overview renders both market panels", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto("/");

  // Fundamental: heading, a parsed weight chip, a stance section, headlines.
  await expect(page.getByRole("heading", { name: "Fundamental" })).toBeVisible();
  await expect(page.getByText("base 70%")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What flips me" })).toBeVisible();
  await expect(page.getByText("Latest headlines")).toBeVisible();

  // Technical: heading, ladder rows, regime line, indicator readout.
  await expect(page.getByRole("heading", { name: "Technical" })).toBeVisible();
  // Exact match: the stance prose itself contains "200DMA" as a substring
  // (in the View and What-flips-me bullets), which collides with a plain
  // substring getByText and produces a Playwright strict-mode violation.
  await expect(page.getByText("200DMA", { exact: true })).toBeVisible();
  await expect(page.getByText("pivot S1")).toBeVisible();
  await expect(page.getByText("above 50DMA, below 200DMA")).toBeVisible();
  await expect(page.getByText("RSI14")).toBeVisible();

  // The panel must never render a buy/sell verdict.
  await expect(page.getByText(/strong buy|strong sell|recommend/i)).toHaveCount(0);

  // Ops survives, demoted.
  await expect(page.getByText("runs")).toBeVisible();
  expect(errors).toEqual([]);
});
