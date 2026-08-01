import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Playwright owns e2e/**; without this exclude vitest's default glob
    // also picks up e2e/smoke.spec.ts and fails ("did not expect test() to
    // be called here") since it's a different `test()` than @playwright/test's.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
