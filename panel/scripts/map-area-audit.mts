/**
 * Scratch: how faithful is the fundamental map's AREA channel, really?
 *
 * Reports, per tile, the value layoutMap assigned it and the pixels it
 * actually got, so the two distortions between "tier" and "size on screen"
 * can be quantified rather than asserted:
 *   1. the theme multiplier, which scales tier weight before squarifying;
 *   2. the 24px group header, which is taken out of each group's box AFTER
 *      the group was sized by its summed value, so px-per-value is not
 *      constant across groups.
 *
 *   JAMASP_ROOT=/tmp/jamasp-mapdesign npx tsx scripts/map-area-audit.mts
 */
import { getScoredItems } from "../lib/db";
import { readFittedWeights } from "../lib/files";
import { buildThemeMultipliers, layoutMap, tierWeight } from "../lib/marketmap";

const since = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const items = getScoredItems(since);
const mult = buildThemeMultipliers(readFittedWeights()?.fits?.theme?.coefficients);
const boxes = layoutMap(items, { x: 0, y: 0, w: 1200, h: 600 }, 24, mult);

console.log(`items=${items.length} multipliers=${JSON.stringify(mult)}\n`);

const rows: { tier: number; theme: string; px: number; head: string }[] = [];
for (const b of boxes) {
  const inner = b.items.reduce((s, c) => s + c.w * c.h, 0);
  const value = b.items.reduce((s, c) => s + tierWeight(c.node.tier) * (mult[b.theme] ?? 1), 0);
  console.log(`${b.theme.padEnd(14)} box=${(b.w * b.h).toFixed(0).padStart(7)}px ` +
    `children=${inner.toFixed(0).padStart(7)}px value=${value.toFixed(1).padStart(7)} ` +
    `px/value=${(inner / value).toFixed(1).padStart(7)}  ` +
    `header tax=${(100 * (1 - inner / (b.w * b.h))).toFixed(1)}%`);
  for (const c of b.items) {
    rows.push({ tier: c.node.tier, theme: b.theme, px: c.w * c.h, head: c.node.headline });
  }
}

rows.sort((a, b) => b.px - a.px);
console.log("\nlargest 6 tiles on screen:");
for (const r of rows.slice(0, 6)) {
  console.log(`  tier ${r.tier}  ${r.px.toFixed(0).padStart(6)}px  ${r.theme.padEnd(13)} ${r.head.slice(0, 52)}`);
}
const t5 = rows.filter(r => r.tier === 5);
console.log(`\ntier-5 tiles: ${t5.map(r => `${r.px.toFixed(0)}px`).join(", ") || "none"}`);
const biggest = rows[0];
if (t5.length) {
  console.log(`biggest tile is tier ${biggest.tier}; it is ` +
    `${(biggest.px / t5[0].px).toFixed(2)}x the largest tier-5 tile`);
}
