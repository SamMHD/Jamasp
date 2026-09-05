import { type Tone } from "@/lib/marketmap";

/**
 * Tile primitives shared by both market maps.
 *
 * This file exists so the correctness-bearing parts of a tile live in one
 * place: the hatch that makes two CVD-failing colour pairs separable, the
 * <title> that has to sit on the group rather than the rect, and the label
 * wrapping. A second copy in the technical map would be a second place for
 * each of those to regress, and they are the parts nobody re-derives when
 * they regress.
 */

export const MAP_HATCH_ID = "map-hatch";

/**
 * The hatch pattern definition. Every SVG that paints a bearish tile must
 * render this once — a url(#map-hatch) reference into an SVG that has no
 * such pattern paints nothing, which silently removes the second encoding
 * rather than failing visibly.
 */
export function MapHatchDefs() {
  return (
    <defs>
      <pattern id={MAP_HATCH_ID} patternUnits="userSpaceOnUse" width="6" height="6"
        patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="black" strokeOpacity="0.25"
          strokeWidth="2" />
      </pattern>
    </defs>
  );
}

export const TONE_FILL: Record<Tone, string> = {
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
 *
 * These are theme-aware CSS variables, not literal hex, because the pairing
 * inverts between themes: the dark ramp's poles are bright (want dark ink)
 * and its mids/neutral are dark (want light ink), while the light ramp's
 * poles are dark and saturated (want light ink) and its mids/neutral are
 * pale (want dark ink). A fixed hex here would silently stop matching one
 * theme's fills — see app/globals.css's --map-ink-* / --dk-map-ink-*
 * comments and test/palette.test.ts's "market-map ink-on-fill contrast"
 * block, which holds every pairing to the 4.5:1 ink floor.
 */
export const TONE_INK: Record<Tone, string> = {
  bull: "var(--map-ink-bull)",
  "bull-mid": "var(--map-ink-bull-mid)",
  neutral: "var(--map-ink-neutral)",
  "bear-mid": "var(--map-ink-bear-mid)",
  bear: "var(--map-ink-bear)",
};

export const isBearish = (t: Tone): boolean => t === "bear" || t === "bear-mid";

/**
 * Inter's ascent and descent as multiples of the font size (1984/2048 and
 * 494/2048). They place the baseline inside a tile — see `MapTile`.
 */
const ASCENT = 0.97;
const DESCENT = 0.25;

/**
 * The label's FLOOR font size, not its only one.
 *
 * Every tile's label is sized to fill its own rectangle (see `fitLabel`), so
 * this is the smallest type the map will ever draw — the size at which a tile
 * only just qualifies for a label at all, and the size the MIN_LABEL_*
 * thresholds below are derived from. A treemap whose tiles range from a
 * postage stamp to a quarter of the canvas but sets every label in one small
 * size wastes the area channel it worked to compute: the big tiles read as
 * empty colour blocks with a caption in the corner.
 */
export const LABEL_FONT = 10;
export const LABEL_PAD = 4;

/**
 * The label's CEILING font size. A taste limit, not a safety one — `fitLabel`
 * measures the painted block (ascent + descent, not the bare font size), so
 * nothing overflows at any ceiling. Without one, though, a two-word signal
 * name in a quarter-canvas tile sets at 70px+ and reads as a poster rather
 * than a map. 48px is about where a tile still reads as a tile.
 */
export const LABEL_FONT_MAX = 48;

/**
 * Glyph width for this sans-serif stack (Inter), as a fraction of font-size.
 *
 * Deliberately ABOVE the true mixed-case average (~0.5), and above the widest
 * label the maps actually carry — "sma200" measures 0.64 — because this
 * number now decides how large a label is SET, not just where a caption is
 * truncated. Underestimate it and the tallest tiles' text hangs past the
 * right edge, which is the one failure a treemap label must not have;
 * overestimate it and narrow-glyph text is set a step smaller than it could
 * have been, which nobody notices. Real per-glyph metrics would need a
 * browser measurement pass and a client component — see `fitLabel` for why
 * this stays a first-paint-correct estimate instead.
 */
export const AVG_CHAR_W = 0.66;

/**
 * Group headers are uppercased and letter-spaced (0.08em), both of which cost
 * width the mixed-case AVG_CHAR_W does not account for. Sizing a header with
 * AVG_CHAR_W overruns its box by roughly a fifth.
 */
export const HEADER_CHAR_W = 0.70;

/** Group-header type, floor and ceiling — same fill-your-box rule, smaller range. */
export const HEADER_FONT_MIN = 9;
export const HEADER_FONT_MAX = 15;

/** Height of the strip `layoutGroups` reserves above each group's children. */
export const GROUP_HEADER_H = 24;

/**
 * Minimum tile size that can hold one line of truncated label without
 * clipping: MIN_LABEL_W leaves room for a ~6-character truncated headline
 * plus padding on both sides at LABEL_FONT; MIN_LABEL_H is one line of
 * LABEL_FONT text plus padding top and bottom. Both are coupled to
 * LABEL_FONT/LABEL_PAD above — change the font size, recheck these.
 * MIN_LABEL_W = 4*2 + 6*(10*0.66) ≈ 48px; MIN_LABEL_H = 10 + 4*2 = 18px.
 */
export const MIN_LABEL_W = LABEL_PAD * 2 + 6 * LABEL_FONT * AVG_CHAR_W;
export const MIN_LABEL_H = LABEL_FONT + LABEL_PAD * 2;

/** Truncate `text` to whatever fits `w` px at `fontSize`, ellipsis-safe. */
export function truncateForWidth(
  text: string, w: number, fontSize: number, charW: number = AVG_CHAR_W,
): string {
  const maxChars = Math.floor((w - LABEL_PAD * 2) / (fontSize * charW));
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Line advance as a multiple of the font size. 1.25x is the usual compromise
 * between legibility and fitting lines into a small tile. It is a ratio rather
 * than a constant because the font is now per-tile: a 32px label needs a 40px
 * advance, not the 12.5px one a 10px label needs.
 */
export const LINE_RATIO = 1.25;

/**
 * Wrap a headline into a tile at a given size — the FLOOR case, called with
 * the default size by `fitLabel` when no larger size fits the text whole.
 *
 * SVG has no text wrapping, so this measures in characters through
 * AVG_CHAR_W. That estimate sits above the widest label rather than on the
 * average, so a line of narrow characters underfills a little and no line
 * overhangs; exact fitting would need real text metrics, which means
 * measuring in a browser — not worth a client component for a label.
 *
 * The last line ellipsises rather than the text simply stopping, so a
 * truncated headline is visibly truncated: on a map whose whole job is
 * showing what is there, a silently clipped headline reads as the whole
 * headline.
 */
export function wrapForTile(
  text: string, w: number, h: number, fontSize: number = LABEL_FONT,
): string[] {
  const budget = budgets(w, h, fontSize);
  const { lines, complete } = wrapWithin(text, budget);
  if (complete || !lines.length) return lines;

  const last = lines[lines.length - 1];
  lines[lines.length - 1] = last.length >= budget.maxChars
    ? `${last.slice(0, Math.max(1, budget.maxChars - 1))}…`
    : `${last}…`;
  return lines;
}

/**
 * How many characters fit on a line, and how many lines fit in the box, at
 * `fontSize`.
 *
 * The first line costs its own height; each line after it costs a full
 * line-advance. Dividing the whole box by the advance instead would yield
 * zero lines at exactly MIN_LABEL_H (10px of text in an 18px tile) and
 * silently drop labels this component has always shown.
 *
 * What the FIRST line costs is the one thing that differs between the two
 * callers, and it is a real difference rather than an oversight:
 *
 *   - at the floor size (`wrapForTile`) it costs `fontSize`. That is the
 *     historical budget, and it is what lets a 10px label live in an 18px
 *     tile — the ~2px the ascender and descender exceed it by are absorbed
 *     by the padding, invisibly.
 *   - during the size search (`fitLabel`) it costs the painted height,
 *     ascent + descent. At 40px that difference is 9px, which is more than
 *     the padding has to give, so charging only `fontSize` would hand the
 *     search a size whose descenders fall through the bottom edge.
 */
function budgets(w: number, h: number, fontSize: number, painted = false):
  { maxChars: number; maxLines: number } {
  const firstLine = painted ? fontSize * (ASCENT + DESCENT) : fontSize;
  return {
    maxChars: Math.floor((w - LABEL_PAD * 2) / (fontSize * AVG_CHAR_W)),
    maxLines: 1 + Math.floor(
      (h - LABEL_PAD * 2 - firstLine) / (fontSize * LINE_RATIO)),
  };
}

/**
 * Greedy word wrap inside a character/line budget.
 *
 * `complete` reports whether every word made it in. That is the whole point
 * of splitting this out of `wrapForTile`: `fitLabel` needs to ask "does the
 * text fit at this size?" without an ellipsis already having been glued on,
 * and "does the rendered last line end in …" is not the same question — a
 * headline may legitimately end in one.
 */
function wrapWithin(
  text: string, { maxChars, maxLines }: { maxChars: number; maxLines: number },
  breakWords: boolean = true,
): { lines: string[]; complete: boolean } {
  if (maxChars <= 0 || maxLines <= 0) return { lines: [], complete: false };

  // Split on any whitespace run, so repeated spaces in a feed headline cannot
  // produce an empty line — a blank <tspan> still advances the baseline and
  // would punch a visible gap through the middle of the text.
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  let complete = true;

  /** Commit a line; false once the box is full. */
  const push = (s: string): boolean => {
    if (lines.length >= maxLines) return false;
    lines.push(s);
    return true;
  };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    // The word does not fit after what is already on this line. Flush the
    // line FIRST, then judge the word against a full empty line — checking
    // it only when `line` was already empty (as this did until the size
    // became variable) lets an over-long word ride out on a fresh line
    // unmeasured, and the fit search then reads that as "fits", which is
    // how a 9-character word ended up set at 18px in a 6-character tile.
    if (line && !push(line)) { complete = false; break; }
    line = "";

    if (word.length <= maxChars) { line = word; continue; }

    // No word boundary to wrap on. Breaking is the only alternative to
    // overflowing the tile, which is what the budget exists to prevent —
    // but only once the size search has bottomed out. Mid-search a word
    // that does not fit simply means "too big", so `fitLabel` tries a
    // smaller size instead of shattering "bollinger" into "bolling/er".
    if (!breakWords) { complete = false; break; }
    let rest = word;
    while (rest.length > maxChars) {
      if (!push(rest.slice(0, maxChars))) { complete = false; break; }
      rest = rest.slice(maxChars);
    }
    if (!complete) break;
    line = rest;
  }
  if (complete && line && !push(line)) complete = false;

  return { lines, complete };
}

/**
 * The largest font size at which `text` fits inside a w x h tile, with the
 * lines it wraps to at that size.
 *
 * This is what makes a label fill its rectangle instead of sitting in the
 * corner of it at one fixed size. It is a deterministic search — no DOM
 * measurement, no client component, no post-paint reflow — so the first
 * server-rendered paint is already correct, which matters for a page that is
 * server-rendered precisely so it needs no JavaScript to be readable.
 *
 * The search starts from a real upper bound rather than from LABEL_FONT_MAX,
 * so it converges in a handful of steps per tile:
 *   - `ah / (ASCENT + DESCENT)`: one painted line can be no taller than the box;
 *   - `aw / AVG_CHAR_W`: a line must hold at least one character;
 *   - the area bound: n characters at font f need about
 *     n * (f*AVG_CHAR_W) * (f*LINE_RATIO) of area, so f is at most
 *     sqrt(area / (n * AVG_CHAR_W * LINE_RATIO)). Wrapping wastes space at
 *     line ends, so the achievable size is at or below this — which is what
 *     makes it a sound starting point rather than a guess.
 *
 * Below LABEL_FONT the label is dropped rather than shrunk: MIN_LABEL_W /
 * MIN_LABEL_H are the sizes at which one line of floor-size text fits, and
 * a sliver of a tile is better left as pure colour than filled with single
 * broken-up letters. Both maps get that threshold from here rather than
 * applying it themselves, so they cannot drift apart on it.
 */
export function fitLabel(text: string, w: number, h: number):
  { fontSize: number; lines: string[] } {
  const chars = text.trim().length;
  if (!chars || w < MIN_LABEL_W || h < MIN_LABEL_H) {
    return { fontSize: LABEL_FONT, lines: [] };
  }

  const aw = w - LABEL_PAD * 2;
  const ah = h - LABEL_PAD * 2;
  const areaCap = Math.sqrt((aw * ah) / (chars * AVG_CHAR_W * LINE_RATIO));
  const start = Math.floor(Math.min(
    LABEL_FONT_MAX, ah / (ASCENT + DESCENT), aw / AVG_CHAR_W, areaCap));

  for (let f = start; f > LABEL_FONT; f -= 1) {
    const { lines, complete } = wrapWithin(text, budgets(w, h, f, true), false);
    if (complete && lines.length) return { fontSize: f, lines };
  }
  // Nothing fits whole: fall back to the floor size and let the text
  // ellipsise, exactly as it did before labels were fitted at all.
  return { fontSize: LABEL_FONT, lines: wrapForTile(text, w, h) };
}

/**
 * A group header sized to its own box, on the same rule as the tiles.
 *
 * Shared rather than written out in both maps: the two rendered identical
 * <text> elements, and a header that stayed 9px while the tiles under it
 * grew would look like a mistake on both of them.
 */
export function MapGroupHeader({ x, y, w, label }: {
  x: number; y: number; w: number; label: string;
}) {
  const fontSize = Math.max(HEADER_FONT_MIN, Math.min(
    HEADER_FONT_MAX,
    Math.floor((w - LABEL_PAD * 2) / (Math.max(1, label.length) * HEADER_CHAR_W)),
  ));
  return (
    <text x={x + LABEL_PAD}
      y={y + (GROUP_HEADER_H - fontSize * (ASCENT + DESCENT)) / 2 + fontSize * ASCENT}
      fontSize={fontSize} fill="var(--muted-foreground)"
      style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
      {truncateForWidth(label, w, fontSize, HEADER_CHAR_W)}
    </text>
  );
}

/**
 * One tile: fill, mandatory hatch on both bearish tones, hover title, and
 * wrapped label lines.
 *
 * `dashed` marks a weight that has not been fitted yet. Solid means measured;
 * dashed means "this is 1.0 for want of a sample", which on a map whose area
 * channel encodes learned importance is the difference between a claim and a
 * placeholder.
 */
export function MapTile({ x, y, w, h, tone, title, lines,
  fontSize = LABEL_FONT, dashed = false }: {
  x: number; y: number; w: number; h: number;
  tone: Tone; title: string; lines: string[];
  fontSize?: number; dashed?: boolean;
}) {
  // The wrapped block is centred vertically rather than pinned to the top.
  // At the floor size that is barely a change; on a large tile whose label
  // fits in fewer lines than the box could hold, top-pinned text reads as
  // having slipped up into a corner.
  //
  // Centring has to be done against the PAINTED height, not against
  // `fontSize * lines`: the glyphs of a line span ascent + descent, about
  // 1.22x the font size in Inter, and a baseline placed with the naive
  // 0.8 * fontSize rule puts the tallest tiles' ascenders a pixel or two
  // above their own rectangle. Both ratios are rounded up rather than to
  // the nearest, since erring high pushes the block INTO the tile.
  const lineH = fontSize * LINE_RATIO;
  const blockH = fontSize * (ASCENT + DESCENT)
    + Math.max(0, lines.length - 1) * lineH;
  const top = Math.max(0, Math.min((h - blockH) / 2, h - blockH));

  return (
    <g>
      {/* <title> lives on the group, not the base rect: under default
          pointer-events, the hatch overlay below paints on top of the base
          rect and becomes the topmost hit target, which would otherwise
          swallow the tooltip on every bearish tile. A title on the group
          survives whichever child is actually hit. */}
      <title>{title}</title>
      <rect x={x} y={y} width={w} height={h} fill={TONE_FILL[tone]}
        stroke="var(--background)" strokeWidth="1"
        strokeDasharray={dashed ? "3 2" : undefined} />
      {isBearish(tone) && (
        <rect x={x} y={y} width={w} height={h}
          fill={`url(#${MAP_HATCH_ID})`} pointerEvents="none" />
      )}
      {lines.length > 0 && (
        <text x={x + LABEL_PAD} y={y + top + fontSize * ASCENT}
          fontSize={fontSize} fill={TONE_INK[tone]}>
          {lines.map((line, i) => (
            // Each tspan repeats x so the line returns to the tile's left
            // edge; dy advances all but the first.
            <tspan key={i} x={x + LABEL_PAD} dy={i === 0 ? 0 : lineH}>{line}</tspan>
          ))}
        </text>
      )}
    </g>
  );
}

const LEGEND_STEPS: { tone: Tone; label: string }[] = [
  { tone: "bear", label: "bearish" },
  { tone: "bear-mid", label: "bearish (mid)" },
  { tone: "neutral", label: "neutral" },
  { tone: "bull-mid", label: "bullish (mid)" },
  { tone: "bull", label: "bullish" },
];

export function MapLegend() {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted-foreground">
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
