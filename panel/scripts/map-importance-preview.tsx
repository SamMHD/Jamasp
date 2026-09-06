/**
 * Scratch harness for the fundamental map's importance-channel exploration.
 * Not part of the app — it exists so the options can be compared side by side
 * against REAL production data instead of the 2-tile test fixture.
 *
 *   JAMASP_ROOT=/tmp/jamasp-mapdesign \
 *   PANEL_CSS=/tmp/jamasp-mapdesign/out/panel.css \
 *   npx tsx scripts/map-importance-preview.tsx /tmp/jamasp-mapdesign/out
 *
 * Writes one standalone HTML page per (treatment x theme x viewport). The
 * SVG in those pages is byte-for-byte what the server component renders, so
 * screenshots of them are screenshots of the real map; only the surrounding
 * page chrome is a stand-in, and even that uses the panel's own compiled CSS
 * when PANEL_CSS points at it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketMap } from "../components/market-map";
import type { ImportanceTreatment } from "../components/map-tiles";
import { getScoredItems } from "../lib/db";
import { readFittedWeights } from "../lib/files";
import { buildThemeMultipliers, type MapRange } from "../lib/marketmap";

const outDir = process.argv[2] ?? "/tmp/jamasp-mapdesign/out";
mkdirSync(outDir, { recursive: true });

const css = process.env.PANEL_CSS ? readFileSync(process.env.PANEL_CSS, "utf8") : "";

const TREATMENTS: { key: ImportanceTreatment; title: string; blurb: string }[] = [
  { key: "none", title: "Baseline — area + colour only",
    blurb: "What ships today. Area = tier x theme multiplier, colour = direction x conviction, hatch = bearish." },
  { key: "pips", title: "Option A — tier pips",
    blurb: "Five fixed-size marks across the top of each tile, `tier` of them filled. Fixed geometry, so a run of three reads the same on any tile. Costs 6px of label box." },
  { key: "boundary", title: "Option B — publish-gate boundary",
    blurb: "A stroke on the news pipeline's own gates: solid = posted immediately (tier 4+), dashed = held for the rollup (tier 3), none = never sent. Costs the label nothing." },
  { key: "meta", title: "Option C — meta line",
    blurb: "A second, smaller line reading the tier and what the channel did with it. Costs 20px of label box, and only larger tiles can afford it." },
];

const VIEWPORTS = [
  { key: "desktop", px: 1200 },
  { key: "mobile", px: 390 },
];

const THEMES = ["light", "dark"] as const;

const range = (process.env.MAP_RANGE as MapRange) ?? "24h";
const sinceMs = range === "week" ? 7 * 86_400_000 : 86_400_000;
const since = new Date(Date.now() - sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z");

const items = getScoredItems(since);
const weights = readFittedWeights();
const themeMultipliers = buildThemeMultipliers(weights?.fits?.theme?.coefficients);

console.log(`range=${range} items=${items.length} multipliers=${JSON.stringify(themeMultipliers)}`);

const page = (body: string, theme: string, widthPx: number) => `<!doctype html>
<html lang="en" class="${theme}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>
  body { margin: 0; background: var(--background); color: var(--foreground);
         font-family: ui-sans-serif, system-ui, -apple-system, "Inter", sans-serif; }
  .wrap { width: ${widthPx}px; padding: 16px; box-sizing: border-box; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  p.blurb { font-size: 12px; margin: 0 0 12px; color: var(--muted-foreground); max-width: 70ch; }
</style>
</head><body><div class="wrap">${body}</div></body></html>`;

const index: string[] = [];

for (const t of TREATMENTS) {
  const svg = renderToStaticMarkup(
    <MarketMap items={items} width={1200} height={600} range={range}
      coverage={{ scored: items.length, unscored: 0 }}
      themeMultipliers={themeMultipliers}
      fittedAt={weights?.fittedAt ?? null}
      importance={t.key} />);
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const name = `${t.key}-${theme}-${vp.key}.html`;
      writeFileSync(path.join(outDir, name), page(
        `<h1>${t.title}</h1><p class="blurb">${t.blurb}</p>${svg}`, theme, vp.px));
      index.push(name);
    }
  }
}

writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({
  range, items: items.length, themeMultipliers, pages: index,
}, null, 2));
console.log(`wrote ${index.length} pages to ${outDir}`);
