import { fmtAge } from "@/lib/format";
import { layoutMap, tone, type MapRange, type ScoredItem, type Tone } from "@/lib/marketmap";

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
 */

const THEME_HEADER_H = 20;

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

const TONE_FILL: Record<Tone, string> = {
  bull: "var(--map-bull)",
  "bull-mid": "var(--map-bull-mid)",
  neutral: "var(--map-neutral)",
  "bear-mid": "var(--map-bear-mid)",
  bear: "var(--map-bear)",
};

/**
 * The two poles (bull, bear) are the bright, saturated ramp steps; the
 * mid and neutral steps are dark. One ink for all five would be unreadable
 * on at least two of them, so ink follows each tile's own fill rather than
 * being fixed.
 */
const TONE_INK: Record<Tone, string> = {
  bull: "#0a0a0a",
  "bull-mid": "#f5f5f5",
  neutral: "#f5f5f5",
  "bear-mid": "#f5f5f5",
  bear: "#0a0a0a",
};

const isBearish = (t: Tone): boolean => t === "bear" || t === "bear-mid";

const WINDOW_LABEL: Record<MapRange, string> = {
  today: "today",
  week: "this week",
};

const LABEL_FONT = 10;
const HEADER_FONT = 9;
const LABEL_PAD = 4;

/**
 * Average glyph width for this sans-serif stack, as a fraction of
 * font-size, for mixed-case headline text — used only to pick a
 * truncation length, not for pixel-exact layout, so an estimate is fine.
 */
const AVG_CHAR_W = 0.58;

/**
 * Minimum tile size that can hold one line of truncated label without
 * clipping: MIN_LABEL_W leaves room for a ~6-character truncated headline
 * plus padding on both sides at LABEL_FONT; MIN_LABEL_H is one line of
 * LABEL_FONT text plus padding top and bottom. Both are coupled to
 * LABEL_FONT/LABEL_PAD above — change the font size, recheck these.
 * MIN_LABEL_W = 4*2 + 6*(10*0.58) ≈ 43px; MIN_LABEL_H = 10 + 4*2 = 18px.
 */
const MIN_LABEL_W = LABEL_PAD * 2 + 6 * LABEL_FONT * AVG_CHAR_W;
const MIN_LABEL_H = LABEL_FONT + LABEL_PAD * 2;

/** Truncate `text` to whatever fits `w` px at `fontSize`, ellipsis-safe. */
function truncateForWidth(text: string, w: number, fontSize: number): string {
  const maxChars = Math.floor((w - LABEL_PAD * 2) / (fontSize * AVG_CHAR_W));
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function tileTitle(item: ScoredItem, now: Date): string {
  const dirWord = item.direction > 0 ? "bullish" : item.direction < 0 ? "bearish" : "neutral";
  const sign = item.direction > 0 ? "+" : "";
  return `${item.headline} — tier ${item.tier}, ${dirWord} ${sign}${item.direction} `
    + `(conviction ${item.conviction.toFixed(2)}), ${item.source}, ${fmtAge(item.publishedAt, now)}`;
}

const LEGEND_STEPS: { tone: Tone; label: string }[] = [
  { tone: "bear", label: "bearish" },
  { tone: "bear-mid", label: "bearish (mid)" },
  { tone: "neutral", label: "neutral" },
  { tone: "bull-mid", label: "bullish (mid)" },
  { tone: "bull", label: "bullish" },
];

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      {LEGEND_STEPS.map(s => (
        <span key={s.tone} className="flex items-center gap-1">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[2px]"
            style={{ background: TONE_FILL[s.tone] }} />
          {s.label}
        </span>
      ))}
      <span className="flex items-center gap-1">
        {/* Same hatch as the tiles, drawn with CSS rather than the SVG
            <pattern> so this key never emits a url(#map-hatch) reference —
            the compliance test asserts that string appears only on
            actually-bearish tiles. */}
        <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] border border-border"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, currentColor 0, currentColor 1px, transparent 1px, transparent 4px)",
            color: "var(--map-bear)",
          }} />
        hatched = bearish
      </span>
    </div>
  );
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
    <section aria-label="Scored news treemap" className="rounded border border-border p-4">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img"
        aria-label={`scored news treemap, ${items.length} scored stories ${WINDOW_LABEL[range]}`}>
        <defs>
          <pattern id="map-hatch" patternUnits="userSpaceOnUse" width="6" height="6"
            patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="black" strokeOpacity="0.25" strokeWidth="2" />
          </pattern>
        </defs>
        {boxes.map(box => (
          <g key={box.theme}>
            <text x={box.x + LABEL_PAD} y={box.y + 13} fontSize={HEADER_FONT}
              fill="var(--muted-foreground)"
              style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {truncateForWidth(themeLabel(box.theme), box.w, HEADER_FONT)}
            </text>
            {box.items.map(cell => {
              const t = tone(cell.node.direction, cell.node.conviction);
              const bearish = isBearish(t);
              const showLabel = cell.w >= MIN_LABEL_W && cell.h >= MIN_LABEL_H;
              return (
                <g key={cell.node.itemId}>
                  {/* <title> lives on the group, not the base rect: under
                      default pointer-events, the hatch overlay below paints
                      on top of the base rect and becomes the topmost hit
                      target, which would otherwise swallow the tooltip on
                      every bearish tile. A title on the group survives
                      whichever child is actually hit. */}
                  <title>{tileTitle(cell.node, now)}</title>
                  <rect x={cell.x} y={cell.y} width={cell.w} height={cell.h}
                    fill={TONE_FILL[t]} stroke="var(--background)" strokeWidth="1" />
                  {bearish && (
                    <rect x={cell.x} y={cell.y} width={cell.w} height={cell.h}
                      fill="url(#map-hatch)" pointerEvents="none" />
                  )}
                  {showLabel && (
                    <text x={cell.x + LABEL_PAD} y={cell.y + LABEL_PAD + LABEL_FONT * 0.8}
                      fontSize={LABEL_FONT} fill={TONE_INK[t]}>
                      {truncateForWidth(cell.node.headline, cell.w, LABEL_FONT)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
      <Legend />
      <p className="mt-2 text-xs text-muted-foreground">
        {coverage.scored} scored {coverage.scored === 1 ? "story" : "stories"} {WINDOW_LABEL[range]}
        {" "}· {coverage.unscored} unscored not shown
      </p>
    </section>
  );
}
