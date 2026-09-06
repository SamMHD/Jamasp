/**
 * Scratch harness, pair to scripts/map-importance-preview.tsx.
 *
 * Screenshots every preview page and runs the map's two hard guarantees
 * against the LIVE DOM, not against the geometry model that produced it:
 *   1. zero label overflow — every painted text bbox inside its own tile rect
 *   2. one ink colour per theme — computed `fill` on every label resolves to
 *      a single value, which is the property PR #33's ramp rebuild bought
 * and records the label cost of each treatment (how many labels survive, and
 * how large they are set), which is what each option has to justify.
 *
 *   node scripts/map-shots.mjs [outDir] [shotsDir]
 */
import { chromium } from "playwright";
import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = process.argv[2] ?? "/tmp/jamasp-mapdesign/out";
const SHOTS = process.argv[3] ?? "/tmp/jamasp-mapdesign/shots";
mkdirSync(SHOTS, { recursive: true });

const pages = readdirSync(OUT).filter(f => f.endsWith(".html")).sort();

const audit = () => {
  // Sub-pixel slack: getBBox is float and the rect coordinates are float too,
  // but the browser rounds glyph extents. Anything above this is a real
  // overhang, not a rounding artifact.
  const EPS = 0.5;
  const out = {
    overflow: [], labels: 0, metas: 0, inks: {}, tiles: 0, sizes: [], clipped: 0,
  };
  // A MapTile group is exactly the one whose FIRST child is the hover <title>.
  // Selecting on `g > g` alone would also match the rail's own wrapper group
  // and measure labels against the rail track instead of the tile.
  for (const g of document.querySelectorAll("svg g > g")) {
    if (g.firstElementChild?.tagName.toLowerCase() !== "title") continue;
    const rect = g.querySelector(":scope > rect");
    if (!rect) continue;
    out.tiles += 1;
    const rx = parseFloat(rect.getAttribute("x"));
    const ry = parseFloat(rect.getAttribute("y"));
    const rw = parseFloat(rect.getAttribute("width"));
    const rh = parseFloat(rect.getAttribute("height"));
    for (const t of g.querySelectorAll("text")) {
      const b = t.getBBox();
      // The meta line is the only text carrying fill-opacity.
      const isMeta = t.getAttribute("fill-opacity") !== null;
      if (isMeta) out.metas += 1;
      else {
        out.labels += 1;
        out.sizes.push(parseFloat(t.getAttribute("font-size")));
        // A headline that had to be cut. This is the real price of a
        // treatment that eats label box, and the number the option's
        // write-up has to quote.
        if (t.textContent.includes("…")) out.clipped += 1;
      }
      const fill = getComputedStyle(t).fill;
      out.inks[fill] = (out.inks[fill] ?? 0) + 1;
      if (b.x < rx - EPS || b.y < ry - EPS
          || b.x + b.width > rx + rw + EPS || b.y + b.height > ry + rh + EPS) {
        out.overflow.push({
          text: t.textContent.slice(0, 40),
          bbox: [+b.x.toFixed(2), +b.y.toFixed(2), +b.width.toFixed(2), +b.height.toFixed(2)],
          rect: [rx, ry, rw, rh],
        });
      }
    }
  }
  return out;
};

const browser = await chromium.launch();
const results = [];
for (const file of pages) {
  const isMobile = file.includes("mobile");
  const ctx = await browser.newContext({
    viewport: { width: isMobile ? 390 : 1280, height: isMobile ? 780 : 900 },
    deviceScaleFactor: 2,
    colorScheme: file.includes("dark") ? "dark" : "light",
  });
  const page = await ctx.newPage();
  await page.goto("file://" + path.join(OUT, file));
  await page.waitForTimeout(350);
  const a = await page.evaluate(audit);
  await page.screenshot({
    path: path.join(SHOTS, file.replace(/\.html$/, ".png")), fullPage: true });
  const mean = a.sizes.length
    ? a.sizes.reduce((s, v) => s + v, 0) / a.sizes.length : 0;
  results.push({ file, ...a, inks: Object.keys(a.inks), meanFont: +mean.toFixed(2) });
  await ctx.close();
}
await browser.close();

writeFileSync(path.join(SHOTS, "audit.json"), JSON.stringify(results, null, 2));

let totalOverflow = 0, totalText = 0;
for (const r of results) {
  totalOverflow += r.overflow.length;
  totalText += r.labels + r.metas;
  console.log(
    `${r.file.padEnd(34)} tiles=${String(r.tiles).padStart(4)} ` +
    `labels=${String(r.labels).padStart(4)} meta=${String(r.metas).padStart(4)} ` +
    `clipped=${String(r.clipped).padStart(3)} meanFont=${String(r.meanFont).padStart(6)} ` +
    `overflow=${r.overflow.length} inks=${r.inks.length} ${r.inks.join(",")}`);
}
console.log(`\nTOTAL measured text elements: ${totalText}`);
console.log(`TOTAL overflows: ${totalOverflow}`);
if (totalOverflow > 0) process.exitCode = 1;
