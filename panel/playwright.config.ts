import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// The provisioned browser at /opt/pw-browsers doesn't match the revision
// this @playwright/test version expects — launch it via its known path
// where it exists; elsewhere fall back to the default lookup.
const provisioned = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:3311",
    launchOptions: existsSync(provisioned)
      ? { executablePath: provisioned }
      : {},
  },
  webServer: {
    command: "npm run fixture && npm run dev -- -p 3311",
    url: "http://127.0.0.1:3311",
    env: { JAMASP_ROOT: "./test/fixtures/root" },
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
