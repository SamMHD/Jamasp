import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:3311",
    launchOptions: {
      // The provisioned browser at /opt/pw-browsers doesn't match the
      // revision this @playwright/test version expects. Launching it
      // download-free via its known path instead of the default lookup.
      executablePath: "/opt/pw-browsers/chromium",
    },
  },
  webServer: {
    command: "npm run fixture && npm run dev -- -p 3311",
    url: "http://127.0.0.1:3311",
    env: { JAMASP_ROOT: "./test/fixtures/root" },
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
