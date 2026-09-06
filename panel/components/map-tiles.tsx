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
 * than a map.
 *
 * 34, not 48. At 48 the largest tiles were three and a half times the size of
 * the group headers above them and nearly five times the floor: the biggest
 * headline stopped being a label and became the page's masthead, and the eye
 * had nowhere to go afterwards. The area channel already says which tile
 * matters; the type only has to stay readable across the range, and a 3.4x
 * ramp does that without shouting. Flattening the top of the ramp (several
 * large tiles now share the ceiling) is the point, not a side effect.
 */
export const LABEL_FONT_MAX = 34;

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
 * Tracking (letter-spacing) in em, as a function of the size a label is set
 * at. Optical sizing: the same face needs to be pulled together at 34px and
 * opened up at 10px, or a map whose labels span a 3.4x range reads as if it
 * were set in two different typefaces. Large type takes negative tracking,
 * small type positive — the standard rule, applied in three steps rather
 * than continuously because a label's size is already an integer.
 *
 * This is not a paint-time flourish: letter-spacing changes how wide a line
 * actually is, so it is folded into the width budget (`charAdvance` below).
 * A budget that ignored it would hand the fit a size whose painted text is
 * wider than the tile — precisely the failure the budget exists to prevent.
 */
export function trackingFor(fontSize: number): number {
  if (fontSize >= 28) return -0.022;
  if (fontSize >= 20) return -0.015;
  if (fontSize >= 14) return -0.005;
  return 0.005;
}

/**
 * Weight follows size the opposite way from tracking. 10px type on a
 * saturated fill needs the extra stem width to hold together; the same
 * weight at 34px reads as shouting. Both values are real weights on Inter's
 * variable axis, which `next/font` loads whole (app/layout.tsx calls
 * `Inter()` with no `weight`, which is what selects the variable file), so
 * neither is synthesised.
 */
export function weightFor(fontSize: number): number {
  return fontSize >= 20 ? 550 : 600;
}

/** Per-character advance in em: the glyph estimate plus this size's tracking. */
export function charAdvance(fontSize: number): number {
  return AVG_CHAR_W + trackingFor(fontSize);
}

/**
 * The narrowest advance any size can produce. The size search's opening
 * bounds have to be UPPER bounds to stay sound, so they divide by this
 * rather than by the advance at some particular size.
 */
const TIGHTEST_ADVANCE = AVG_CHAR_W - 0.022;

/**
 * Group headers are uppercased and letter-spaced (0.08em), both of which cost
 * width the mixed-case AVG_CHAR_W does not account for. Sizing a header with
 * AVG_CHAR_W overruns its box by roughly a fifth.
 */
export const HEADER_CHAR_W = 0.70;

/**
 * Group-header type, floor and ceiling — same fill-your-box rule, smaller
 * range. The ceiling came down from 15 with the tile ceiling: a header is a
 * section marker, and at 15px semibold next to a 34px tile label it read as
 * a competing headline rather than as the thing naming the group.
 */
export const HEADER_FONT_MIN = 10;
export const HEADER_FONT_MAX = 13;

/** Height of the strip `layoutGroups` reserves above each group's children. */
export const GROUP_HEADER_H = 24;

/**
 * Minimum tile size that can hold one line of truncated label without
 * clipping: MIN_LABEL_W leaves room for a ~6-character truncated headline
 * plus padding on both sides at LABEL_FONT; MIN_LABEL_H is one line of
 * LABEL_FONT text plus padding top and bottom. Both are coupled to
 * LABEL_FONT/LABEL_PAD above — change the font size, recheck these.
 * MIN_LABEL_W = 4*2 + 6*(10*0.665) ≈ 48px; MIN_LABEL_H = 10 + 4*2 = 18px.
 * (0.665 is `charAdvance(LABEL_FONT)`: AVG_CHAR_W plus the floor size's
 * +0.005em tracking, so the threshold measures the type as it is painted.)
 */
export const MIN_LABEL_W =
  LABEL_PAD * 2 + 6 * LABEL_FONT * charAdvance(LABEL_FONT);
export const MIN_LABEL_H = LABEL_FONT + LABEL_PAD * 2;

/**
 * ---------------------------------------------------------------------------
 * IMPORTANCE — the third channel. Exploratory; "none" is the default.
 * ---------------------------------------------------------------------------
 *
 * The fundamental map already carries two channels: AREA is materiality (tier
 * times the theme's learned multiplier) and COLOUR is direction scaled by
 * conviction. What it does not carry is a *decodable* importance readout.
 * Area is relative, and the theme multiplier scales it, so a tier-3 story in
 * a theme the fit never reached can out-size a tier-5 story in a theme the
 * fit pushed to 0.25 — on the live panel today it does exactly that.
 *
 * Each treatment adds ONE mark reporting `tier`: Jamasp's own importance
 * field, the 1-5 materiality call jamasp/flashtext.py asks the triage model
 * for, and the gate config/settings.yaml's flash tiers act on. They are
 * alternatives, not layers — pick one.
 *
 *   "pips"     five fixed-size marks at the top of the tile, `tier` of them
 *              filled. Absolute, and comparable BETWEEN tiles — which a bar
 *              measured as a fraction of the tile's own width is not: a
 *              tier-4 bar on a wide tile out-runs a tier-5 bar on a narrow
 *              one, so the reader compares lengths and gets the answer
 *              backwards. Fixed geometry is what makes the mark a reading.
 *   "boundary" a stroke keyed to the pipeline's own gates — posted / held /
 *              never posted. Three states, and it costs the label nothing.
 *   "meta"     a second, smaller line under the headline reading the tier and
 *              what the pipeline did with it. The TradingView-heatmap move
 *              (ticker over % change): a literal readout, but it needs room,
 *              so only the larger tiles get it.
 *
 * All three paint in the tile's own ink (TONE_INK), so the "one ink per
 * theme" property the ramp was rebuilt for survives; and all three reserve
 * their band OUT of the label box before `fitLabel` runs, so the zero-overflow
 * guarantee stays geometric and correct on the first server-rendered paint.
 */
export type ImportanceTreatment = "none" | "pips" | "boundary" | "meta";

/** The whole tier scale, so tier/MAX_TIER is a fraction of a full rail. */
export const MAX_TIER = 5;

/**
 * The news pipeline's own tier gates, mirroring config/settings.yaml's
 * `flash.post_tier_min` / `flash.rollup_tier_min` exactly as TIER_WEIGHT
 * mirrors config/weights.yaml. They are what makes "importance" an
 * operational fact on this desk rather than a bare number: at or above
 * `post` a story went to the news channel immediately, at or above `rollup`
 * it was held for the four-times-daily roundup, below that it never reached
 * the channel at all. Callers with `loadSettings()` to hand can pass the real
 * values; these are the fallback, so a drift between the two files shows up
 * as a mislabelled tile rather than a crash.
 */
export const POST_TIER_MIN = 4;
export const ROLLUP_TIER_MIN = 3;

export type TierGates = { post: number; rollup: number };
export const DEFAULT_TIER_GATES: TierGates = {
  post: POST_TIER_MIN, rollup: ROLLUP_TIER_MIN,
};

/** What the pipeline did with a story at this tier. */
export type TierFate = "posted" | "held" | "quiet";

export function tierFate(tier: number, gates: TierGates = DEFAULT_TIER_GATES): TierFate {
  if (tier >= gates.post) return "posted";
  if (tier >= gates.rollup) return "held";
  return "quiet";
}

/**
 * Pip geometry, in px and FIXED — not a fraction of the tile. The whole point
 * of the treatment is that five pips look the same on a 60px tile and a 400px
 * one, so "three filled" reads as tier 3 wherever the eye lands.
 */
export const PIP_W = 5;
export const PIP_H = 3;
export const PIP_GAP = 2;
export const PIPS_W = MAX_TIER * PIP_W + (MAX_TIER - 1) * PIP_GAP;
/** The pip band: the pips themselves plus 3px of air before the label box. */
export const PIP_BAND = PIP_H + 3;

/**
 * Below this a tile cannot hold the full run of pips inside its padding, and
 * a clipped run reads as a lower tier — the one failure this mark must not
 * have. Too small, and it draws nothing rather than lying.
 */
export const PIP_MIN_W = PIPS_W + LABEL_PAD * 2;
export const PIP_MIN_H = 12;

/**
 * Meta band: a CONSTANT 20px reserved at the bottom, which is what keeps the
 * meta line out of the circular dependency it would otherwise have — the
 * label's size depends on the reserve, so a reserve derived from the label's
 * size depends on itself. 20px holds the meta ceiling (14px, painted at
 * ascent + descent = 17.1px) with room to centre it in the band.
 */
export const META_BAND = 20;
export const META_FONT_MIN = 9;
export const META_FONT_MAX = 14;

/** The widest meta string, which is what the width test has to clear. */
const META_WIDEST = "T5 · POSTED";

/** The meta line's text for a tier. Already uppercase. */
export function metaTextFor(tier: number, gates: TierGates = DEFAULT_TIER_GATES): string {
  const fate = tierFate(tier, gates);
  return `T${tier} · ${fate === "posted" ? "POSTED" : fate === "held" ? "HELD" : "QUIET"}`;
}

/**
 * How much of a tile a treatment takes away from the label box.
 *
 * Both the caller (which sizes the label) and `MapTile` (which positions it)
 * read this, so the two cannot disagree about where the label box is — the
 * one way a reserved band turns back into an overflow.
 *
 * A treatment that cannot fit its own band reserves nothing and draws
 * nothing, rather than painting over the label. On a map whose tiles run from
 * a quarter of the canvas down to a few pixels, "sometimes absent" is the
 * honest behaviour, and it is the cost each option has to own.
 */
export function importanceInsets(
  treatment: ImportanceTreatment, w: number, h: number,
): { top: number; bottom: number } {
  if (treatment === "pips") {
    return (w >= PIP_MIN_W && h >= PIP_MIN_H)
      ? { top: PIP_BAND, bottom: 0 } : { top: 0, bottom: 0 };
  }
  if (treatment === "meta") {
    const fits = h >= META_BAND + MIN_LABEL_H
      && w - LABEL_PAD * 2 >= META_WIDEST.length * META_FONT_MIN * HEADER_CHAR_W;
    return fits ? { top: 0, bottom: META_BAND } : { top: 0, bottom: 0 };
  }
  // "boundary" paints inside the tile's own edge and "none" paints nothing,
  // so neither costs the label a pixel.
  return { top: 0, bottom: 0 };
}

/** Truncate `text` to whatever fits `w` px at `fontSize`, ellipsis-safe. */
export function truncateForWidth(
  text: string, w: number, fontSize: number, charW?: number,
): string {
  const maxChars = Math.floor(
    (w - LABEL_PAD * 2) / (fontSize * (charW ?? charAdvance(fontSize))));
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Line advance as a multiple of the font size. It is a ratio rather than a
 * constant because the font is per-tile: a 32px label needs a 38px advance,
 * not the 12px one a 10px label needs.
 *
 * 1.2, tightened from 1.25. A wrapped tile label is a title, not body copy,
 * and at 1.25 a four-line headline read as four separate captions stacked up
 * rather than one block. 1.2 is still clear of collision: what a line
 * actually inks is about 0.75em of ascender and 0.21em of descender in Inter
 * (0.96em together), so consecutive lines keep roughly a quarter of an em
 * between them even though the nominal em boxes (1.22em, ASCENT + DESCENT)
 * now overlap slightly. The fit charges the full 1.22em for the first line
 * regardless, so the overlap costs nothing in safety.
 */
export const LINE_RATIO = 1.2;

/**
 * How many characters a line must be able to hold before a wrap counts as
 * readable, when the text is that long at all.
 *
 * The size search maximises type size. Maximising type size minimises how
 * many characters fit on a line, and past a point that stops being "big and
 * legible" and becomes a column of orphans — the live map was setting
 * "Dollar index slides to a three-week low" as six lines with the word "a"
 * alone on one of them. Requiring a line to hold at least this many
 * characters costs a size step or two and buys back the sentence.
 *
 * It is a preference, not a constraint: a tile too narrow to hold twelve
 * characters at any size still gets the largest label that fits, because the
 * alternative is no label at all. See `fitLabel`.
 */
export const MIN_LINE_CHARS = 12;

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
    maxChars: Math.floor((w - LABEL_PAD * 2) / (fontSize * charAdvance(fontSize))),
    maxLines: 1 + Math.floor(
      (h - LABEL_PAD * 2 - firstLine) / (fontSize * LINE_RATIO)),
  };
}

/**
 * Split a word at the seams a reader already expects a break on: after an
 * internal hyphen or underscore. "three-week" parts as "three-" / "week" and
 * "net_spec" as "net_" / "spec", both of which keep the word's shape; cutting
 * the same words mid-run gives "three-w" / "eek" and "net_sp" / "ec", which
 * do not.
 *
 * The delimiter stays on the LEFT piece, which is what makes the break read
 * as a break rather than as two words. A trailing delimiter is not a seam —
 * nothing follows it — so this never returns an empty piece. Written as a
 * scan rather than a lookbehind regex so it needs nothing newer than ES5.
 */
function seamSplit(word: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < word.length - 1; i += 1) {
    if (word[i] === "-" || word[i] === "_") {
      out.push(word.slice(start, i + 1));
      start = i + 1;
    }
  }
  out.push(word.slice(start));
  return out;
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

    // Seams first, mid-run cut second. `seamSplit` gives back the pieces a
    // hyphen or underscore already offers; only a piece with no seam left in
    // it (or one still longer than a whole line) gets cut mid-run. That is
    // what turns the live map's "net_sp" / "ec 1d" into "net_" / "spec" /
    // "1d". A word with no seam at all comes back as a single piece, so the
    // shattering path below is exactly what it always was.
    let stopped = false;
    for (const piece of seamSplit(word)) {
      if (line && line.length + piece.length > maxChars) {
        if (!push(line)) { stopped = true; break; }
        line = "";
      }
      let rest = piece;
      while (rest.length > maxChars) {
        if (!push(rest.slice(0, maxChars))) { stopped = true; break; }
        rest = rest.slice(maxChars);
      }
      if (stopped) break;
      line += rest;
    }
    if (stopped) { complete = false; break; }
  }
  if (complete && line && !push(line)) complete = false;

  return { lines, complete };
}

/**
 * Even out a wrap that already fits, without changing how many lines it uses.
 *
 * Greedy wrapping fills each line to the brim and leaves whatever is left
 * over on the last one, which is what turns a headline into a staircase.
 * Narrowing the line budget as far as it will go WITHOUT needing an extra
 * line redistributes the words across the lines already paid for: same size,
 * same line count, same block height, less rag.
 *
 * Every candidate it considers is narrower than the wrap it was handed, so
 * nothing this returns can be wider than something that already fitted — it
 * cannot break the containment guarantee, only improve the margin.
 */
function balanceLines(text: string, lines: string[]): string[] {
  if (lines.length < 2) return lines;
  const target = lines.length;
  let best = lines;
  for (let cap = Math.max(...lines.map(l => l.length)) - 1; cap >= 1; cap -= 1) {
    const r = wrapWithin(text, { maxChars: cap, maxLines: target }, false);
    if (!r.complete || r.lines.length !== target) break;
    best = r.lines;
  }
  return best;
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
 *   - `aw / TIGHTEST_ADVANCE`: a line must hold at least one character;
 *   - the area bound: n characters at font f need about
 *     n * (f*advance) * (f*LINE_RATIO) of area, so f is at most
 *     sqrt(area / (n * advance * LINE_RATIO)). Wrapping wastes space at
 *     line ends, so the achievable size is at or below this — which is what
 *     makes it a sound starting point rather than a guess. Both bounds
 *     divide by TIGHTEST_ADVANCE rather than by the advance at f, because a
 *     starting point is only sound if it is an over-estimate.
 *
 * Two answers come out of the one descending pass, because both are monotone
 * in f (a smaller size fits whenever a larger one does, and a smaller size
 * always gets MORE characters on a line):
 *   - `relaxed` — the largest size at which the text fits at all. What this
 *     function used to return outright.
 *   - the returned size — the largest that ALSO gives a line room for
 *     MIN_LINE_CHARS characters, which is what stops a big tile from setting
 *     a headline one or two words per line. When no size clears that (a tile
 *     genuinely too narrow), `relaxed` is used instead: a stack of short
 *     lines still beats no label.
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
  const areaCap = Math.sqrt((aw * ah) / (chars * TIGHTEST_ADVANCE * LINE_RATIO));
  const start = Math.floor(Math.min(
    LABEL_FONT_MAX, ah / (ASCENT + DESCENT), aw / TIGHTEST_ADVANCE, areaCap));

  // Text shorter than MIN_LINE_CHARS wants its whole self on one line, not
  // twelve characters' worth of room it has no words for.
  const wantChars = Math.min(chars, MIN_LINE_CHARS);
  let relaxed: { fontSize: number; lines: string[] } | null = null;

  for (let f = start; f > LABEL_FONT; f -= 1) {
    const budget = budgets(w, h, f, true);
    const { lines, complete } = wrapWithin(text, budget, false);
    if (!complete || !lines.length) continue;
    if (relaxed === null) relaxed = { fontSize: f, lines };
    if (budget.maxChars >= wantChars) {
      return { fontSize: f, lines: balanceLines(text, lines) };
    }
  }
  if (relaxed) {
    return { fontSize: relaxed.fontSize, lines: balanceLines(text, relaxed.lines) };
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
 *
 * Deliberately still flush LEFT while the tiles below it are centred. A group
 * header is not a tile: it names the block that starts under it, and setting
 * it against the block's left edge is what marks where one group ends and the
 * next begins on a surface that is otherwise wall-to-wall colour. Centring it
 * would leave it floating over the seam between two of its own children.
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
      style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>
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
 *
 * `importance` is the optional third channel (see ImportanceTreatment above).
 * It defaults to "none", so the technical map — which has no tier — and any
 * caller that has not opted in render exactly as they did before it existed.
 * When it is on, the caller MUST have sized `lines`/`fontSize` against
 * `h - importanceInsets(...).top - .bottom`, which is what keeps the label
 * inside the box the treatment left it.
 */
export function MapTile({ x, y, w, h, tone, title, lines,
  fontSize = LABEL_FONT, dashed = false,
  importance = "none", tier, gates = DEFAULT_TIER_GATES }: {
  x: number; y: number; w: number; h: number;
  tone: Tone; title: string; lines: string[];
  fontSize?: number; dashed?: boolean;
  importance?: ImportanceTreatment; tier?: number; gates?: TierGates;
}) {
  // The wrapped block is centred on BOTH axes.
  //
  // Vertically, against the PAINTED height rather than `fontSize * lines`:
  // the glyphs of a line span ascent + descent, about 1.22x the font size in
  // Inter, and a baseline placed with the naive 0.8 * fontSize rule puts the
  // tallest tiles' ascenders a pixel or two above their own rectangle. Both
  // ratios are rounded up rather than to the nearest, since erring high
  // pushes the block INTO the tile. Measured on the live map, that lands the
  // actual ink within a tenth of an em of the rect's centre line (mean
  // -0.006em over 55 labels): Inter's 0.24em of unused room above cap height
  // and its 0.25em of descent cancel almost exactly, so the em box and the
  // ink share a centre. Only descender-heavy labels sit low, and by at most
  // 0.10em — compensating per string would make neighbouring tiles'
  // baselines jitter for less than a pixel of gain, so they are left alone.
  //
  // Horizontally, on the tile's own centre line. This is the half that was
  // wrong: the label used to start one 4px pad from the left edge whatever
  // the tile's width, so a label vertically centred to within a pixel could
  // sit with 4px to its left and 106px to its right. Flush-left is a fine
  // choice and centred is a fine choice; centred on one axis and flush on
  // the other is the one combination that reads as broken, because the eye
  // has a centre line to compare against and the text misses it.
  // A treatment's band is taken off the top and/or bottom BEFORE the block is
  // centred, so the label centres in what is left rather than in the whole
  // tile. `importanceInsets` is the same function the caller sized the label
  // with, so the two agree by construction.
  const showImportance = importance !== "none" && tier !== undefined;
  const inset = showImportance
    ? importanceInsets(importance, w, h) : { top: 0, bottom: 0 };
  const boxY = y + inset.top;
  const boxH = Math.max(0, h - inset.top - inset.bottom);

  const lineH = fontSize * LINE_RATIO;
  const blockH = fontSize * (ASCENT + DESCENT)
    + Math.max(0, lines.length - 1) * lineH;
  const top = Math.max(0, Math.min((boxH - blockH) / 2, boxH - blockH));
  const cx = x + w / 2;

  // --- pips: five fixed marks, `tier` of them filled ---
  const pipsOn = showImportance && importance === "pips" && inset.top > 0;
  const pipX0 = cx - PIPS_W / 2;
  const pipY = y + (PIP_BAND - PIP_H) / 2;

  // --- boundary: a stroke on the pipeline's own gates, inset so it paints
  // inside the tile rather than over the 1px separator its neighbour shares.
  const fate = showImportance ? tierFate(tier!, gates) : "quiet";
  const boundaryOn = showImportance && importance === "boundary"
    && fate !== "quiet" && w > 6 && h > 6;
  const boundaryW = fate === "posted" ? 2 : 1.5;

  // --- meta: the tier readout, sized off the headline it sits under so the
  // two read as one block rather than as two unrelated labels.
  const metaOn = showImportance && importance === "meta" && inset.bottom > 0;
  const metaFont = Math.max(META_FONT_MIN,
    Math.min(META_FONT_MAX, Math.round(fontSize * 0.5)));
  const metaText = metaOn ? metaTextFor(tier!, gates) : "";
  // Uppercase and letter-spaced, so it is measured with HEADER_CHAR_W for the
  // same reason MapGroupHeader is. A meta line that does not fit is dropped,
  // never truncated: "T5 · POST…" is a worse readout than no readout.
  const metaFits = metaOn
    && metaText.length * metaFont * HEADER_CHAR_W <= w - LABEL_PAD * 2;

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
      {boundaryOn && (
        // strokeWidth straddles the path, so the rect is inset by half of it
        // and the whole stroke lands inside the tile. fill="none" keeps the
        // hatch and the fill below visible through it.
        <rect x={x + boundaryW / 2} y={y + boundaryW / 2}
          width={Math.max(0, w - boundaryW)} height={Math.max(0, h - boundaryW)}
          fill="none" stroke={TONE_INK[tone]} strokeWidth={boundaryW}
          strokeOpacity={fate === "posted" ? 0.9 : 0.45}
          strokeDasharray={fate === "held" ? "4 3" : undefined}
          pointerEvents="none" />
      )}
      {pipsOn && (
        // The empty pips are drawn too, not just the filled ones: without the
        // run's full length on screen there is no denominator, and "three
        // marks" stops meaning "three out of five".
        <g pointerEvents="none">
          {Array.from({ length: MAX_TIER }, (_, i) => (
            <rect key={i} x={pipX0 + i * (PIP_W + PIP_GAP)} y={pipY}
              width={PIP_W} height={PIP_H} rx={PIP_H / 2}
              fill={TONE_INK[tone]}
              fillOpacity={i < (tier ?? 0) ? 0.95 : 0.22} />
          ))}
        </g>
      )}
      {metaFits && (
        <text x={cx} y={y + h - inset.bottom
          + (META_BAND - metaFont * (ASCENT + DESCENT)) / 2 + metaFont * ASCENT}
          textAnchor="middle" fontSize={metaFont} fill={TONE_INK[tone]}
          fillOpacity={0.72} pointerEvents="none"
          style={{ fontWeight: 600, letterSpacing: "0.06em" }}>
          {metaText}
        </text>
      )}
      {lines.length > 0 && (
        <text x={cx} y={boxY + top + fontSize * ASCENT} textAnchor="middle"
          fontSize={fontSize} fill={TONE_INK[tone]}
          style={{
            fontWeight: weightFor(fontSize),
            letterSpacing: `${trackingFor(fontSize)}em`,
          }}>
          {lines.map((line, i) => (
            // Each tspan repeats x so the line returns to the tile's centre
            // line — with text-anchor: middle every line centres on its own,
            // which is what makes a wrapped block read as a centred block
            // rather than as a centred first line with a ragged tail. dy
            // advances all but the first.
            <tspan key={i} x={cx} dy={i === 0 ? 0 : lineH}>{line}</tspan>
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

/**
 * The importance key, appended to the legend when a treatment is on.
 *
 * A third channel nobody can name is not a channel, it is decoration — so a
 * treatment that ships has to ship its key with it. Drawn with CSS rather
 * than SVG for the same reason the hatch key is: this markup must not emit
 * a url(#map-hatch) reference, which the compliance test reads as "a bearish
 * tile".
 */
function ImportanceKey({ treatment }: { treatment: ImportanceTreatment }) {
  if (treatment === "none") return null;
  if (treatment === "pips") {
    return (
      <span className="flex items-center gap-1">
        <span aria-hidden className="flex items-center gap-[2px]">
          {Array.from({ length: MAX_TIER }, (_, i) => (
            <span key={i} className="h-[3px] w-[5px] rounded-full"
              style={{
                background: "var(--muted-foreground)",
                opacity: i < 3 ? 0.95 : 0.22,
              }} />
          ))}
        </span>
        filled pips = tier (of {MAX_TIER})
      </span>
    );
  }
  if (treatment === "boundary") {
    return (
      <>
        <span className="flex items-center gap-1">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[2px]"
            style={{ border: "2px solid var(--foreground)" }} />
          posted now (tier {POST_TIER_MIN}+)
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[2px]"
            style={{ border: "1.5px dashed var(--muted-foreground)" }} />
          held for the rollup (tier {ROLLUP_TIER_MIN})
        </span>
      </>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden className="font-semibold tracking-wider">T1–T5</span>
      = tier · POSTED / HELD / QUIET = what the news channel did with it
    </span>
  );
}

export function MapLegend({ importance = "none" }: {
  importance?: ImportanceTreatment;
}) {
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
      <ImportanceKey treatment={importance} />
    </div>
  );
}
