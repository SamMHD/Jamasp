import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors tsconfig.json's "@/*": ["./*"] — the first components/ file
  // imported directly by a test (level-ladder.tsx, via @/lib/technicals and
  // @/lib/format) fails to resolve without this; Next's own bundler applies
  // the tsconfig alias for the app itself, but vitest runs outside it.
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
  test: {
    // Playwright owns e2e/**; without this exclude vitest's default glob
    // also picks up e2e/smoke.spec.ts and fails ("did not expect test() to
    // be called here") since it's a different `test()` than @playwright/test's.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
