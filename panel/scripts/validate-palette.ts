// Local CLI over the same checks the test runs, for when you are fitting a
// ramp by hand and want the numbers without a test harness in the way.
//   npm run validate:palette
import { readFileSync } from "node:fs";
import path from "node:path";
import { contrast, labOf } from "../lib/color";
import { checkInks, checkSeries, INK_FLOOR, parseTokens, type Theme } from "../lib/palette";

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
  "dk-map-bull", "dk-map-bear", "dk-map-neutral",
  "map-bull", "map-bear", "map-neutral",
  "dk-map-bull-mid", "dk-map-bear-mid", "map-bull-mid", "map-bear-mid",
  "dk-map-ink-bull", "dk-map-ink-bull-mid", "dk-map-ink-neutral",
  "dk-map-ink-bear-mid", "dk-map-ink-bear",
  "map-ink-bull", "map-ink-bull-mid", "map-ink-neutral",
  "map-ink-bear-mid", "map-ink-bear",
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
  // Poles only — the mid steps and the neutral are only ever adjacent to
  // their own neighbours on the ramp, so the poles are the pair a reader
  // actually compares across a treemap.
  ["dark map poles", [T["dk-map-bull"], T["dk-map-bear"]], T["dk-card"]],
  ["light map poles", [T["map-bull"], T["map-bear"]], T["card"]],
];
for (const [label, hexes, surface] of seriesChecks) {
  for (const f of checkSeries(hexes, surface)) {
    if (!f.ok) failed++;
    console.log(`  ${f.ok ? "PASS" : "FAIL"}  ${label} ${f.label.padEnd(46)} dE ${f.measured.toFixed(1)}`);
  }
}

console.log("\n=== market-map midpoint achromaticity (hypot(a,b) < 4) ===");
const ACHROMATIC_FLOOR = 4;
for (const [label, token] of [["dark", "dk-map-neutral"], ["light", "map-neutral"]] as const) {
  const [, a, b] = labOf(T[token]);
  const hypot = Math.hypot(a, b);
  const ok = hypot < ACHROMATIC_FLOOR;
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} ${token}`.padEnd(46) + ` hypot(a,b) ${hypot.toFixed(2)}`);
}

console.log(`\n=== market-map ink-on-fill contrast (>= ${INK_FLOOR}:1) ===`);
const inkChecks: [string, string, string][] = [
  ["dark", "dk-map-ink-bull", "dk-map-bull"],
  ["dark", "dk-map-ink-bull-mid", "dk-map-bull-mid"],
  ["dark", "dk-map-ink-neutral", "dk-map-neutral"],
  ["dark", "dk-map-ink-bear-mid", "dk-map-bear-mid"],
  ["dark", "dk-map-ink-bear", "dk-map-bear"],
  ["light", "map-ink-bull", "map-bull"],
  ["light", "map-ink-bull-mid", "map-bull-mid"],
  ["light", "map-ink-neutral", "map-neutral"],
  ["light", "map-ink-bear-mid", "map-bear-mid"],
  ["light", "map-ink-bear", "map-bear"],
];
for (const [label, inkTok, fillTok] of inkChecks) {
  const measured = contrast(T[inkTok], T[fillTok]);
  const ok = measured >= INK_FLOOR;
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} ${inkTok} on ${fillTok}`.padEnd(46) + ` ${measured.toFixed(2)}:1`);
}

process.exit(failed > 0 ? 1 : 0);
