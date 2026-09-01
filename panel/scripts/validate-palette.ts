// Local CLI over the same checks the test runs, for when you are fitting a
// ramp by hand and want the numbers without a test harness in the way.
//   npm run validate:palette
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkInks, checkSeries, parseTokens, type Theme } from "../lib/palette";

const T = parseTokens(readFileSync(path.join(import.meta.dirname, "../app/globals.css"), "utf8"));

// Every token name the checks below read out of T. Reported by name up
// front rather than left to blow up inside contrast()/hexToRgb() with a bare
// "Cannot read properties of undefined" — this runs interactively while
// hand-fitting a ramp, where a stack trace is useless and a token list is
// actionable.
const REQUIRED_TOKENS = [
  "dk-background", "dk-card", "dk-secondary",
  "dk-foreground", "dk-muted-foreground", "dk-ink-dim", "dk-primary", "dk-up", "dk-down",
  "dk-viz-1", "dk-viz-2", "dk-viz-3",
  "background", "card", "secondary",
  "foreground", "muted-foreground", "ink-dim", "primary", "up", "down",
  "viz-1", "viz-2", "viz-3",
];
const missing = REQUIRED_TOKENS.filter(name => T[name] === undefined);
if (missing.length > 0) {
  console.error(`Missing from globals.css: ${missing.join(", ")}`);
  process.exit(1);
}

const themes: Theme[] = [
  { name: "dark", surfaces: { field: T["dk-background"], panel: T["dk-card"], raised: T["dk-secondary"] },
    inks: { foreground: T["dk-foreground"], muted: T["dk-muted-foreground"], dim: T["dk-ink-dim"],
            gold: T["dk-primary"], up: T["dk-up"], down: T["dk-down"] } },
  { name: "light", surfaces: { field: T["background"], panel: T["card"], inset: T["secondary"] },
    inks: { foreground: T["foreground"], muted: T["muted-foreground"], dim: T["ink-dim"],
            gold: T["primary"], up: T["up"], down: T["down"] } },
];

let failed = 0;
for (const theme of themes) {
  console.log(`\n=== ${theme.name} ===`);
  for (const f of checkInks(theme)) {
    if (!f.ok) failed++;
    console.log(`  ${f.ok ? "PASS" : "FAIL"}  ${f.label.padEnd(34)} ${f.measured.toFixed(2)}:1`);
  }
}
console.log("\n=== categorical series ===");
const seriesChecks: [string, string[], string][] = [
  ["dark viz", [T["dk-viz-1"], T["dk-viz-2"], T["dk-viz-3"]], T["dk-card"]],
  ["light viz", [T["viz-1"], T["viz-2"], T["viz-3"]], T["card"]],
];
for (const [label, hexes, surface] of seriesChecks) {
  for (const f of checkSeries(hexes, surface)) {
    if (!f.ok) failed++;
    console.log(`  ${f.ok ? "PASS" : "FAIL"}  ${label} ${f.label.padEnd(46)} dE ${f.measured.toFixed(1)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
