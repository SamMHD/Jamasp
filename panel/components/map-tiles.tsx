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

export const LABEL_FONT = 10;
export const LABEL_PAD = 4;

/**
 * Average glyph width for this sans-serif stack, as a fraction of
 * font-size, for mixed-case headline text — used only to pick a
 * truncation length, not for pixel-exact layout, so an estimate is fine.
 */
export const AVG_CHAR_W = 0.58;

/**
 * Minimum tile size that can hold one line of truncated label without
 * clipping: MIN_LABEL_W leaves room for a ~6-character truncated headline
 * plus padding on both sides at LABEL_FONT; MIN_LABEL_H is one line of
 * LABEL_FONT text plus padding top and bottom. Both are coupled to
 * LABEL_FONT/LABEL_PAD above — change the font size, recheck these.
 * MIN_LABEL_W = 4*2 + 6*(10*0.58) ≈ 43px; MIN_LABEL_H = 10 + 4*2 = 18px.
 */
export const MIN_LABEL_W = LABEL_PAD * 2 + 6 * LABEL_FONT * AVG_CHAR_W;
export const MIN_LABEL_H = LABEL_FONT + LABEL_PAD * 2;

/** Truncate `text` to whatever fits `w` px at `fontSize`, ellipsis-safe. */
export function truncateForWidth(text: string, w: number, fontSize: number): string {
  const maxChars = Math.floor((w - LABEL_PAD * 2) / (fontSize * AVG_CHAR_W));
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Line advance for wrapped tile text. 1.25x the font is the usual compromise
 * between legibility and fitting lines into a small tile; it is coupled to
 * LABEL_FONT, so changing one means rechecking the other against MIN_LABEL_H.
 */
export const LINE_H = LABEL_FONT * 1.25;

/**
 * Wrap a headline to fill its tile, rather than showing only its first line.
 *
 * SVG has no text wrapping, so this measures in the same estimated units the
 * label threshold already uses: AVG_CHAR_W is an average over a proportional
 * font, so a line of narrow characters underfills slightly and a line of wide
 * ones can overhang a pixel or two. Exact fitting needs real text metrics,
 * which means measuring in a browser — not worth a client component for a
 * label.
 *
 * The last line ellipsises rather than the text simply stopping, so a
 * truncated headline is visibly truncated: on a map whose whole job is
 * showing what is there, a silently clipped headline reads as the whole
 * headline.
 */
export function wrapForTile(text: string, w: number, h: number): string[] {
  const maxChars = Math.floor((w - LABEL_PAD * 2) / (LABEL_FONT * AVG_CHAR_W));
  // The first line costs only its font height; each line after it costs a
  // full line-advance. Dividing the whole box by LINE_H instead would yield
  // zero lines at exactly MIN_LABEL_H (10px of text in an 18px tile) and
  // silently drop labels this component has always shown.
  const maxLines = 1 + Math.floor((h - LABEL_PAD * 2 - LABEL_FONT) / LINE_H);
  if (maxChars <= 0 || maxLines <= 0) return [];

  // Split on any whitespace run, so repeated spaces in a feed headline cannot
  // produce an empty line — a blank <tspan> still advances the baseline and
  // would punch a visible gap through the middle of the text.
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    if (!line && word.length > maxChars) {
      // No word boundary to wrap on. Breaking is the only alternative to
      // overflowing the tile, which is what the budget exists to prevent.
      let rest = word;
      while (rest.length > maxChars && lines.length < maxLines) {
        lines.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      line = rest;
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
    } else {
      lines.push(line);
      if (lines.length >= maxLines) { line = ""; break; }
      line = word;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);

  const usedAll = lines.join(" ").replace(/\s+/g, " ") ===
    words.join(" ");
  if (!usedAll && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length >= maxChars
      ? `${last.slice(0, Math.max(1, maxChars - 1))}…`
      : `${last}…`;
  }
  return lines.slice(0, maxLines);
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
export function MapTile({ x, y, w, h, tone, title, lines, dashed = false }: {
  x: number; y: number; w: number; h: number;
  tone: Tone; title: string; lines: string[]; dashed?: boolean;
}) {
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
        <text x={x + LABEL_PAD} y={y + LABEL_PAD + LABEL_FONT * 0.8}
          fontSize={LABEL_FONT} fill={TONE_INK[tone]}>
          {lines.map((line, i) => (
            // Each tspan repeats x so the line returns to the tile's left
            // edge; dy advances all but the first.
            <tspan key={i} x={x + LABEL_PAD} dy={i === 0 ? 0 : LINE_H}>{line}</tspan>
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
