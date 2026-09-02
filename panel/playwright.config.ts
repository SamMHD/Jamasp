import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The provisioned browser at /opt/pw-browsers doesn't match the revision
// this @playwright/test version expects — launch it via its known path
// where it exists; elsewhere fall back to the default lookup.
const provisioned = "/opt/pw-browsers/chromium";
const launchOptions = existsSync(provisioned) ? { executablePath: provisioned } : {};

export default defineConfig({
  testDir: "./e2e",
  projects: [
    {
      name: "desktop",
      testIgnore: /mobile\.spec\.ts/,
      use: { baseURL: "http://127.0.0.1:3311", launchOptions, viewport: { width: 1440, height: 900 } },
    },
    {
      // 390x664 — devices["iPhone 13"]'s *viewport* (844 is that device's
      // screen height, not its viewport — the two differ because of the
      // browser chrome Safari reserves). Compact width, regular height: the
      // size class the panel was never tested at, and the one most desk
      // phones report.
      //
      // browserName is pinned to chromium rather than left to devices'
      // own defaultBrowserType ("webkit"): only Chromium is provisioned
      // here (see `provisioned` above), and launchOptions.executablePath
      // only resolves a Chromium binary — spreading the device descriptor
      // as-is would otherwise send this project hunting for a WebKit
      // build that was never installed.
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        baseURL: "http://127.0.0.1:3311",
        launchOptions,
      },
    },
  ],
  webServer: {
    command: "npm run fixture && npm run dev -- -p 3311",
    url: "http://127.0.0.1:3311",
    env: { JAMASP_ROOT: "./test/fixtures/root" },
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
