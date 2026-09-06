/**
 * Fundamental market map: encoding and layout.
 *
 * Pure, like lib/technicals.ts and lib/newsflow.ts — the page does the
 * database read and passes rows in.
 *
 * Two channels carry two different things, deliberately. AREA is materiality
 * (the triage call's tier), so the map's shape answers "what is big today".
 * COLOUR is direction scaled by conviction, so a story that plainly matters
 * but cannot be called comes out large and grey rather than fading away —
 * the desk should see that it matters and is unresolved.
 */

/**
 * The map's short window is a rolling 24 hours, not a Dubai calendar day.
 *
 * It was Dubai-midnight-anchored until the desk hit the consequence: at
 * 00:00 Dubai the map emptied and stayed near-empty for hours, because
 * "today" had barely any scored stories in it. A trailing window answers
 * the question the map is actually for — what is moving now — and never
 * has a cliff.
 *
 * This deliberately disagrees with the Dubai-day boundaries used by the
 * brief, the flash pipeline (jamasp/flashtext.py) and the agent-run cap
 * (lib/db.ts#runsTodayDubai). Those answer "what happened today" and
 * "how many runs have I spent today", which really are calendar-day
 * questions. Do not "fix" this back into alignment with them.
 */
export type MapRange = "24h" | "week";

export type ScoredItem = {
  itemId: string;
  tier: number;
  direction: number;   // -2..+2, gold-relative
  conviction: number;  // 0..1
  theme: string;
  headline: string;
  source: string;
  url: string;
  publishedAt: string;
};

/**
 * Tier -> area weight. Mirrors config/weights.yaml's tier_weight, which the
 * later fit also reads; if that file's values change, change these with it.
 */
export const TIER_WEIGHT: Record<number, number> = {
  5: 100, 4: 60, 3: 30, 2: 10, 1: 3,
};

const MIN_WEIGHT = 3;

export function tierWeight(tier: number): number {
  return TIER_WEIGHT[tier] ?? MIN_WEIGHT;
}

export type Tone = "bull" | "bull-mid" | "neutral" | "bear-mid" | "bear";

/** Below this the read is treated as no call at all. */
const NEUTRAL_BAND = 0.15;
/** At or above this the arm reaches its pole. */
const POLE_BAND = 0.55;

/**
 * Band a signed intensity in [-1, +1] onto the five-step diverging ramp.
 *
 * This is the band logic on its own, because both maps need it from
 * different inputs: the fundamental map derives an intensity from direction
 * and conviction, while a technical signal's state IS an intensity already.
 * The thresholds live here once so a future edit cannot make the two maps
 * disagree about where "neutral" ends.
 */
export function toneFromIntensity(s: number): Tone {
  const a = Math.abs(s);
  if (a < NEUTRAL_BAND) return "neutral";
  if (a < POLE_BAND) return s < 0 ? "bear-mid" : "bull-mid";
  return s < 0 ? "bear" : "bull";
}

/**
 * Signed intensity s = (direction / 2) * conviction, in [-1, +1], mapped onto
 * the five-step diverging ramp.
 *
 * Conviction multiplies rather than gates: direction says which way, and
 * conviction says how far along that arm to travel. A confident +1 and a
 * hesitant +2 can legitimately land on the same step.
 */
export function tone(direction: number, conviction: number): Tone {
  return toneFromIntensity((direction / 2) * conviction);
}

export type Rect = { x: number; y: number; w: number; h: number };
export type Cell<T> = Rect & { node: T };

/**
 * Squarified treemap (Bruls, Huizing & van Wijk 2000).
 *
 * Squarified rather than slice-and-dice because tiles here carry text: a
 * long thin sliver fits no headline at any font size, so aspect ratio is a
 * legibility requirement, not an aesthetic one.
 */
export function squarify<T>(
  nodes: { value: number; node: T }[], rect: Rect,
): Cell<T>[] {
  const out: Cell<T>[] = [];
  const live = nodes.filter(n => n.value > 0);
  const total = live.reduce((s, n) => s + n.value, 0);
  if (!live.length || total <= 0 || rect.w <= 0 || rect.h <= 0) return out;

  const scale = (rect.w * rect.h) / total;
  const queue = live
    .slice()
    .sort((a, b) => b.value - a.value)
    .map(n => ({ node: n.node, area: n.value * scale }));

  let { x: cx, y: cy, w: cw, h: ch } = rect;
  let row: { node: T; area: number }[] = [];

  const worst = (r: typeof row, len: number): number => {
    if (!r.length || len <= 0) return Infinity;
    const s = r.reduce((a, b) => a + b.area, 0);
    if (s <= 0) return Infinity;
    const mx = Math.max(...r.map(v => v.area));
    const mn = Math.min(...r.map(v => v.area));
    return Math.max((len * len * mx) / (s * s), (s * s) / (len * len * mn));
  };

  const flush = (r: typeof row, vertical: boolean): void => {
    const len = vertical ? ch : cw;
    const s = r.reduce((a, b) => a + b.area, 0);
    const thick = s / len;
    let pos = vertical ? cy : cx;
    for (const v of r) {
      const side = v.area / thick;
      out.push(vertical
        ? { node: v.node, x: cx, y: pos, w: thick, h: side }
        : { node: v.node, x: pos, y: cy, w: side, h: thick });
      pos += side;
    }
    if (vertical) { cx += thick; cw -= thick; } else { cy += thick; ch -= thick; }
  };

  let i = 0;
  while (i < queue.length) {
    const vertical = cw >= ch;
    const len = vertical ? ch : cw;
    const candidate = row.concat([queue[i]]);
    if (!row.length || worst(candidate, len) <= worst(row, len)) {
      row = candidate;
      i += 1;
    } else {
      flush(row, vertical);
      row = [];
    }
  }
  if (row.length) flush(row, cw >= ch);
  return out;
}

export type ThemeBox = Rect & {
  theme: string;
  items: Cell<ScoredItem>[];
  total: number;
  /**
   * The theme's learned multiplier, 1.0 when the fit has not reported one.
   * Carried on the box rather than folded into `items`' area — see
   * `layoutMap` for why it is not an area term.
   */
  multiplier: number;
};

export type GroupNode<T> = { group: string; value: number; node: T };
export type GroupBox<T> = Rect & { group: string; items: Cell<T>[]; total: number };

/**
 * Passes of the header-reservation fixed point in `reserveHeaders`, and the
 * relative movement below which it has converged. Two or three passes is
 * enough on every layout either map produces — the widths stop moving once
 * the boxes are roughly right — so the cap is headroom, not the normal path.
 */
const HEADER_PASSES = 8;
const HEADER_EPSILON = 1e-4;

/**
 * Price each group's header into its value, so what squarify apportions is
 * the area that will be left AFTER the headers are taken out.
 *
 * The naive order — size the box by value, then cut a fixed `headerHeight`
 * strip out of the top — makes px-per-value a function of the box's HEIGHT,
 * because the strip costs `headerHeight * width` out of `width * height`. On
 * the desk's own 24h map that ran from a 4% tax on the tallest group to 37%
 * on the shortest: two stories of identical tier came out at wildly
 * different sizes purely from which theme they landed in. Area is this
 * map's importance channel, so that is a lie told in it.
 *
 * What we want is `box_i = k * value_i + headerHeight * width_i`, with the
 * boxes summing to the canvas. That is circular — `width_i` is an output of
 * the layout that its input decides — so it is solved by iterating: lay out,
 * read the widths back, re-price, lay out again. The widths barely move
 * after the first correction, so it settles in a couple of passes.
 *
 * If the headers alone would fill the canvas there is nothing to reserve.
 * The raw values come back and the caller gets the old proportional layout,
 * rather than a divide-by-zero or a loop that diverges.
 */
function reserveHeaders<T>(
  groups: { value: number; node: T }[], rect: Rect, headerHeight: number,
): { value: number; node: T }[] {
  const canvas = rect.w * rect.h;
  const totalValue = groups.reduce((s, g) => s + g.value, 0);
  if (headerHeight <= 0 || totalValue <= 0 || canvas <= 0) return groups;

  let priced = groups;
  for (let pass = 0; pass < HEADER_PASSES; pass++) {
    // squarify sorts and drops zero-value nodes, so the widths come back in
    // neither the input order nor the input length: key them by node
    // identity rather than by position.
    const widths = new Map<T, number>();
    for (const cell of squarify(priced, rect)) widths.set(cell.node, cell.w);

    const headerArea = groups.reduce(
      (s, g) => s + headerHeight * (widths.get(g.node) ?? 0), 0);
    if (headerArea >= canvas) return groups;

    const perValue = (canvas - headerArea) / totalValue;
    const next = groups.map(g => ({
      value: perValue * g.value + headerHeight * (widths.get(g.node) ?? 0),
      node: g.node,
    }));
    const moved = Math.max(...next.map((n, i) =>
      Math.abs(n.value - priced[i].value) / Math.max(n.value, 1e-9)));
    priced = next;
    if (moved < HEADER_EPSILON) break;
  }
  return priced;
}

/**
 * Two-level layout: groups fill the canvas, each group's children fill its
 * box below a reserved header strip.
 *
 * Generic over the node type because both maps are this same layout over
 * different nodes — stories grouped by theme, signals grouped by family.
 * Duplicating it per map would leave two squarify wrappers to keep in step.
 *
 * The header is priced in BEFORE the groups are apportioned (see
 * `reserveHeaders`), so equal value buys equal area wherever it lands. A
 * consequence worth stating: a group's own BOX is no longer proportional to
 * its value — its children's area is, and that is what the eye reads and
 * what `total` is the honest denominator for.
 *
 * Groups with no positive-value children are absent rather than empty. An
 * empty box would claim area and read as "nothing happened in this channel"
 * when what it means is "nothing was filed here" — a different claim, and
 * one the coverage footer is the honest place for.
 */
export function layoutGroups<T>(
  nodes: GroupNode<T>[], rect: Rect, headerHeight: number,
): GroupBox<T>[] {
  const grouped = new Map<string, GroupNode<T>[]>();
  for (const n of nodes) {
    const bucket = grouped.get(n.group);
    if (bucket) bucket.push(n);
    else grouped.set(n.group, [n]);
  }

  const groups = [...grouped.entries()].map(([group, kids]) => ({
    value: kids.reduce((s, k) => s + k.value, 0),
    node: { group, kids },
  }));

  return squarify(reserveHeaders(groups, rect, headerHeight), rect).map(cell => {
    const inner: Rect = {
      x: cell.x,
      y: cell.y + headerHeight,
      w: cell.w,
      h: Math.max(0, cell.h - headerHeight),
    };
    return {
      x: cell.x, y: cell.y, w: cell.w, h: cell.h,
      group: cell.node.group,
      total: cell.node.kids.reduce((s, k) => s + k.value, 0),
      items: squarify(
        cell.node.kids.map(k => ({ value: k.value, node: k.node })), inner),
    };
  });
}

/**
 * The fundamental map's layout: stories grouped by theme, sized by TIER
 * ALONE. The theme's learned multiplier rides along on the box, for the
 * header to report, and does not touch area.
 *
 * ## Why the multiplier is not an area term
 *
 * It used to be: `area = tierWeight(tier) * multiplier[theme]`, straight out
 * of the design (docs/superpowers/specs/2026-08-18-market-maps-design.md
 * §"Area and colour"). On 2026-09-05 the theme fit succeeded for the first
 * time and the desk's 24h map inverted — the largest tile was a TIER 4 at
 * 2.3x the area of the day's only TIER 5, because 60 x 1.0 beats 100 x 0.25.
 *
 * The mechanism is that the two factors are not on one scale and cannot be:
 *
 *  - A *tier* is a per-story materiality judgement the triage model made
 *    when it read the story. It is the answer to "how big is this".
 *  - A *multiplier* is a per-theme regression estimate of how much gold has
 *    historically moved per unit of exposure to that theme over the next 24
 *    hours. It is the answer to "how much does this channel usually matter",
 *    which is a claim about a THEME over MONTHS, not about a story today.
 *
 * Multiplying them yields an area in units of materiality x sensitivity,
 * which is not a quantity anyone reads off a treemap; and because the
 * multiplier's range [0.25, 3.0] is a 12x span while adjacent tiers are only
 * 1.7x apart, the theme factor does not modulate the tier ordering, it
 * overrides it. Encoding two different questions in one visual channel is
 * the defect; nothing about the arithmetic fixes that.
 *
 * The fit's own numbers on the day this was found make the point sharper
 * still. Every one of the six theme coefficients was inside ~1 standard
 * error of zero (the largest, geopolitics, at 0.80 SE), so the multipliers
 * carried no information at all — and what area they did drive was ordered
 * BACKWARDS against the fit: geopolitics had the largest positive beta and
 * rendered at the 0.25 floor, while physical_cb, with a beta seven times
 * smaller, rendered at 1.0 because its 16 observations fell short of
 * `min_observations` and it fell back to neutral. "Not enough data to
 * measure this theme" was being drawn as "this theme is four times as
 * important as every theme we can measure".
 *
 * So: area is the tier, which is what this module's header has always said
 * it is, and the multiplier is theme-level information that belongs in the
 * theme's header alongside the fitted/provisional treatment.
 *
 * REVERSING THIS is one line — put `* (multipliers[it.theme] ?? 1)` back on
 * the value below — plus the tests in test/marketmap.test.ts that name the
 * decision. It changes what the map means, so it should be a decision
 * someone makes on purpose rather than a diff nobody noticed.
 *
 * `multipliers` comes from Fit B via state/weights.json; an absent entry is
 * 1.0, so a deployment whose theme fit has not run yet reports neutral.
 */
export function layoutMap(
  items: ScoredItem[], rect: Rect, headerHeight: number,
  multipliers: Record<string, number> = {},
): ThemeBox[] {
  const boxes = layoutGroups(
    items.map(it => ({ group: it.theme, value: tierWeight(it.tier), node: it })),
    rect, headerHeight);
  return boxes.map(b => ({
    x: b.x, y: b.y, w: b.w, h: b.h,
    theme: b.group, items: b.items, total: b.total,
    multiplier: multipliers[b.group] ?? 1,
  }));
}

export type ThemeCoefficient = {
  multiplier: number; fitted: boolean; pinned: boolean;
};

/**
 * Theme -> the multiplier `layoutMap` should use, from the theme fit's raw
 * coefficients (state/weights.json's `fits.theme.coefficients`, already
 * camelCased by lib/files.ts).
 *
 * A coefficient counts if EITHER it was fitted (the regression measured it)
 * OR it is pinned (a retro overrode it via config/weights.yaml's `pins:`
 * block) — mirrors lib/technicalmap.ts#buildSignalTiles's identical
 * defence, and for the identical reason: jamasp/fit.py's run_fit applies a
 * pin's value to `multiplier` whether or not that column was ever fitted
 * (a retro reaches for a pin exactly for the themes short of min_rows, or
 * with no stories yet), so requiring `fitted === true` here would discard
 * the pin for precisely the cases it exists to fix. `c?.fitted === true` /
 * `c?.pinned === true` (not the bare properties) is deliberate: a malformed
 * coefficient entry that parsed as JSON but arrived as `null` must degrade
 * to "not counted" rather than throw — this reader never 500s on bad state.
 */
export function buildThemeMultipliers(
  coefficients: Record<string, ThemeCoefficient | null | undefined> | undefined,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(coefficients ?? {})
      .filter(([, c]) => c?.fitted === true || c?.pinned === true)
      .map(([key, c]) => [key, c!.multiplier]));
}
