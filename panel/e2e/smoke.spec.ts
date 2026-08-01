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
