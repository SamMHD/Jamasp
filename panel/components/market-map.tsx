import { fmtAge } from "@/lib/format";
import { layoutMap, tone, type MapRange, type ScoredItem } from "@/lib/marketmap";
import { FullscreenButton } from "@/components/fullscreen-button";
import {
  MapHatchDefs, MapLegend, MapTile, LABEL_PAD, MIN_LABEL_H, MIN_LABEL_W,
  truncateForWidth, wrapForTile,
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

const THEME_HEADER_H = 20;

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
  today: "today",
  week: "this week",
};

const HEADER_FONT = 9;

function tileTitle(item: ScoredItem, now: Date): string {
  const dirWord = item.direction > 0 ? "bullish" : item.direction < 0 ? "bearish" : "neutral";
  const sign = item.direction > 0 ? "+" : "";
  return `${item.headline} — tier ${item.tier}, ${dirWord} ${sign}${item.direction} `
    + `(conviction ${item.conviction.toFixed(2)}), ${item.source}, ${fmtAge(item.publishedAt, now)}`;
}

export function MarketMap({ items, width, height, range, coverage }: {
  items: ScoredItem[];
  width: number;
  height: number;
  range: MapRange;
  coverage: { scored: number; unscored: number };
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

  const boxes = layoutMap(items, { x: 0, y: 0, w: width, h: height }, THEME_HEADER_H);

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
            <text x={box.x + LABEL_PAD} y={box.y + 13} fontSize={HEADER_FONT}
              fill="var(--muted-foreground)"
              style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {truncateForWidth(themeLabel(box.theme), box.w, HEADER_FONT)}
            </text>
            {box.items.map(cell => {
              const t = tone(cell.node.direction, cell.node.conviction);
              const showLabel = cell.w >= MIN_LABEL_W && cell.h >= MIN_LABEL_H;
              const lines = showLabel
                ? wrapForTile(cell.node.headline, cell.w, cell.h)
                : [];
              return (
                <MapTile key={cell.node.itemId}
                  x={cell.x} y={cell.y} w={cell.w} h={cell.h}
                  tone={t} title={tileTitle(cell.node, now)} lines={lines} />
              );
            })}
          </g>
        ))}
      </svg>
      <MapLegend />
      <p className="mt-2 text-xs text-muted-foreground">
        {coverage.scored} scored {coverage.scored === 1 ? "story" : "stories"} {WINDOW_LABEL[range]}
        {" "}· {coverage.unscored} unscored not shown
      </p>
    </section>
  );
}
