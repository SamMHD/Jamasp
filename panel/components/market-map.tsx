import { fmtAge } from "@/lib/format";
import { layoutMap, tone, type MapRange, type ScoredItem } from "@/lib/marketmap";
import { FullscreenButton } from "@/components/fullscreen-button";
import {
  MapGroupHeader, MapHatchDefs, MapLegend, MapTile, GROUP_HEADER_H, fitLabel,
  importanceInsets, tierFate, type ImportanceTreatment, type TierGates,
} from "@/components/map-tiles";

/**
 * Fundamental market map: a two-level treemap of scored news, drawn as
 * server-rendered inline SVG for the reasons `sparkline.tsx` gives — no
 * client component, no charting library. Hover is a native SVG <title>,
 * which is a free tooltip that costs no JavaScript.
 *
 * AREA is materiality (tier), COLOUR is direction scaled by conviction —
 * see `lib/marketmap.ts` for why those are two different channels. This
 * component only positions and paints what `layoutMap` already computed.
 *
 * Area is a RELATIVE channel, and `layoutMap` multiplies tier weight by the
 * theme's learned multiplier before squarifying, so a tile's size is not a
 * reading of its tier: with the live fit (rates_dollar/geopolitics/
 * supply_mining/other at 0.25, physical_cb/etf_flows unfitted at 1.0) a
 * tier-4 physical_cb story renders 2.4x the area of the day's only tier-5.
 * The optional `importance` channel exists for exactly that gap — it reports
 * `tier` directly, so importance stops depending on a reader's ability to
 * invert the multiplier by eye. It is off ("none") unless a caller asks.
 *
 * A treemap is an all-pairs surface — any two tiles can end up adjacent — so
 * every one of the ramp's ten step-pairs was measured (see the palette
 * comment in globals.css), not just the poles. Two pairs fail outright:
 * bear/bull-mid at dE 2.8 for protanopes (effectively the same colour) and
 * bear-mid/bull-mid at dE 3.1 for deuteranopes; the pole pair bear/bull
 * (dE 6.9) is only the third worst. Hatching BOTH bearish tones — `bear`
 * and `bear-mid`, not just the pole — gives every failing pair exactly one
 * hatched member, which is what makes them separable without colour. Do
 * not "tidy" the hatch predicate down to the pole: that silently
 * reintroduces the bear-mid/bull-mid and bear/bull-mid failures. The
 * diagonal hatch is the required second encoding, not decoration, and it
 * must survive at any tile size, which rules out a signed number label.
 *
 * The tile primitives themselves (fill/ink tables, hatch, label wrapping)
 * live in `components/map-tiles.tsx`, shared with the technical map.
 */

const THEME_HEADER_H = GROUP_HEADER_H;

/** Shared between the section and the button that fullscreens it. */
export const MAP_ELEMENT_ID = "market-map";

const THEME_LABELS: Record<string, string> = {
  rates_dollar: "Rates & dollar",
  physical_cb: "Physical / CB",
  etf_flows: "ETF flows",
  supply_mining: "Supply & mining",
  geopolitics: "Geopolitics",
  other: "Other",
};

/** Unrecognised slugs degrade to a readable label rather than crashing. */
function themeLabel(theme: string): string {
  return THEME_LABELS[theme] ??
    theme.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

const WINDOW_LABEL: Record<MapRange, string> = {
  "24h": "in the last 24h",
  week: "this week",
};


const FATE_WORD = {
  posted: "posted to the channel",
  held: "held for the rollup",
  quiet: "not sent to the channel",
} as const;

function tileTitle(item: ScoredItem, now: Date, gates?: TierGates): string {
  const dirWord = item.direction > 0 ? "bullish" : item.direction < 0 ? "bearish" : "neutral";
  const sign = item.direction > 0 ? "+" : "";
  return `${item.headline} — tier ${item.tier} (${FATE_WORD[tierFate(item.tier, gates)]}), `
    + `${dirWord} ${sign}${item.direction} `
    + `(conviction ${item.conviction.toFixed(2)}), ${item.source}, ${fmtAge(item.publishedAt, now)}`;
}

/**
 * `importance` selects the third channel — see map-tiles.tsx's
 * ImportanceTreatment block for what each one draws and what it costs.
 * "none" is the default and is byte-for-byte the map as it shipped, so the
 * option is opt-in at the call site rather than something a reader has to
 * turn off.
 */
export function MarketMap({ items, width, height, range, coverage,
  themeMultipliers, fittedAt, importance = "none", tierGates }: {
  items: ScoredItem[];
  width: number;
  height: number;
  range: MapRange;
  coverage: { scored: number; unscored: number };
  themeMultipliers?: Record<string, number>;
  fittedAt?: string | null;
  importance?: ImportanceTreatment;
  tierGates?: TierGates;
}) {
  const now = new Date();

  if (items.length === 0) {
    return (
      <section aria-label="Scored news treemap" className="rounded border border-border p-4">
        <p className="text-sm text-muted-foreground">
          No scored stories {WINDOW_LABEL[range]}
          {coverage.unscored > 0
            ? ` — ${coverage.unscored} unscored item${coverage.unscored === 1 ? "" : "s"} not shown.`
            : "."}
        </p>
      </section>
    );
  }

  const boxes = layoutMap(
    items, { x: 0, y: 0, w: width, h: height }, THEME_HEADER_H, themeMultipliers);
  // The footer's claim must not rest on fittedAt alone: weights.json's
  // fitted_at is one top-level timestamp shared by every fit type, so a
  // caller could pass a truthy fittedAt from a technical-only fit run
  // alongside empty themeMultipliers. Deriving "weighted" from both inputs
  // here — rather than trusting a caller to keep them in sync — is what
  // keeps a second call site, or a future edit to either this file or the
  // page, from silently reintroducing that exact false claim.
  const hasMultipliers = Object.keys(themeMultipliers ?? {}).length > 0;

  return (
    // id is the fullscreen target: FullscreenButton is a client component and
    // resolves it with getElementById, because a server component cannot hold
    // or hand over a ref. bg-background is load-bearing rather than cosmetic —
    // a fullscreened element inherits no background, so the browser paints
    // behind it black and the map would float on it.
    <section id={MAP_ELEMENT_ID} aria-label="Scored news treemap"
      className="rounded border border-border p-4 bg-background">
      <div className="mb-2 flex items-center justify-end">
        <FullscreenButton targetId={MAP_ELEMENT_ID} />
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img"
        aria-label={`scored news treemap, ${items.length} scored stories ${WINDOW_LABEL[range]}`}>
        <MapHatchDefs />
        {boxes.map(box => (
          <g key={box.theme}>
            <MapGroupHeader x={box.x} y={box.y} w={box.w}
              label={themeLabel(box.theme)} />
            {box.items.map(cell => {
              const t = tone(cell.node.direction, cell.node.conviction);
              // The headline is sized to its own tile rather than to one
              // map-wide constant — see map-tiles.tsx#fitLabel. When an
              // importance treatment reserves a band, the label is fitted to
              // what is LEFT of the tile, not to the whole of it: fitting it
              // to the whole tile and then sliding it down is exactly how a
              // reserved band turns into an overflow at the other edge.
              const inset = importanceInsets(importance, cell.w, cell.h);
              const label = fitLabel(cell.node.headline, cell.w,
                cell.h - inset.top - inset.bottom);
              return (
                <MapTile key={cell.node.itemId}
                  x={cell.x} y={cell.y} w={cell.w} h={cell.h}
                  tone={t} title={tileTitle(cell.node, now, tierGates)}
                  lines={label.lines} fontSize={label.fontSize}
                  importance={importance} tier={cell.node.tier} gates={tierGates} />
              );
            })}
          </g>
        ))}
      </svg>
      <MapLegend importance={importance} />
      <p className="mt-2 text-xs text-muted-foreground">
        {coverage.scored} scored {coverage.scored === 1 ? "story" : "stories"} {WINDOW_LABEL[range]}
        {" "}· {coverage.unscored} unscored not shown
        {fittedAt && hasMultipliers
          ? ` · areas weighted by the ${fmtAge(fittedAt, now)} fit`
          : " · weights not yet fitted"}
      </p>
    </section>
  );
}
