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

export type MapRange = "today" | "week";

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
};

export type GroupNode<T> = { group: string; value: number; node: T };
export type GroupBox<T> = Rect & { group: string; items: Cell<T>[]; total: number };

/**
 * Two-level layout: groups fill the canvas, each group's children fill its
 * box below a reserved header strip.
 *
 * Generic over the node type because both maps are this same layout over
 * different nodes — stories grouped by theme, signals grouped by family.
 * Duplicating it per map would leave two squarify wrappers to keep in step.
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

  return squarify(groups, rect).map(cell => {
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
 * The fundamental map's layout: stories grouped by theme, sized by tier and
 * by the theme's learned multiplier.
 *
 * `multipliers` comes from Fit B via state/weights.json. An absent entry is
 * 1.0, so a deployment whose theme fit has not reached min_rows renders
 * exactly as it did before this existed — a map that quietly rescaled itself
 * on the day a fit first succeeded, with nothing on the page saying so, would
 * be a worse outcome than one that says "provisional" for three weeks.
 */
export function layoutMap(
  items: ScoredItem[], rect: Rect, headerHeight: number,
  multipliers: Record<string, number> = {},
): ThemeBox[] {
  const boxes = layoutGroups(
    items.map(it => ({
      group: it.theme,
      value: tierWeight(it.tier) * (multipliers[it.theme] ?? 1),
      node: it,
    })),
    rect, headerHeight);
  return boxes.map(b => ({
    x: b.x, y: b.y, w: b.w, h: b.h,
    theme: b.group, items: b.items, total: b.total,
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
