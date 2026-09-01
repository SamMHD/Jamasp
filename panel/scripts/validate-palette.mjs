// Local CLI over the same checks the test runs, for when you are fitting a
// ramp by hand and want the numbers without a test harness in the way.
//   node scripts/validate-palette.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

register("tsx/esm", import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { checkInks, checkSeries, parseTokens } = await import("../lib/palette.ts");

const T = parseTokens(readFileSync(path.join(here, "../app/globals.css"), "utf8"));
const themes = [
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
for (const [label, hexes, surface] of [
  ["dark viz", [T["dk-viz-1"], T["dk-viz-2"], T["dk-viz-3"]], T["dk-card"]],
  ["light viz", [T["viz-1"], T["viz-2"], T["viz-3"]], T["card"]],
]) {
  for (const f of checkSeries(hexes, surface)) {
    if (!f.ok) failed++;
    console.log(`  ${f.ok ? "PASS" : "FAIL"}  ${label} ${f.label.padEnd(46)} dE ${f.measured.toFixed(1)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
