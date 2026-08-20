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
 * Signed intensity s = (direction / 2) * conviction, in [-1, +1], mapped onto
 * the five-step diverging ramp.
 *
 * Conviction multiplies rather than gates: direction says which way, and
 * conviction says how far along that arm to travel. A confident +1 and a
 * hesitant +2 can legitimately land on the same step.
 */
export function tone(direction: number, conviction: number): Tone {
  const s = (direction / 2) * conviction;
  const a = Math.abs(s);
  if (a < NEUTRAL_BAND) return "neutral";
  if (a < POLE_BAND) return s < 0 ? "bear-mid" : "bull-mid";
  return s < 0 ? "bear" : "bull";
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

/**
 * Two-level layout: themes fill the canvas, each theme's stories fill its
 * box below a reserved header strip.
 *
 * Themes with no items are absent rather than empty. An empty box would
 * claim area and read as "nothing happened in this channel" when what it
 * means is "nothing was filed here" — a different claim, and one the
 * coverage footer is the honest place for.
 */
export function layoutMap(
  items: ScoredItem[], rect: Rect, headerHeight: number,
): ThemeBox[] {
  const grouped = new Map<string, ScoredItem[]>();
  for (const it of items) {
    const bucket = grouped.get(it.theme);
    if (bucket) bucket.push(it);
    else grouped.set(it.theme, [it]);
  }

  const themes = [...grouped.entries()].map(([theme, kids]) => ({
    value: kids.reduce((s, k) => s + tierWeight(k.tier), 0),
    node: { theme, kids },
  }));

  return squarify(themes, rect).map(cell => {
    const inner: Rect = {
      x: cell.x,
      y: cell.y + headerHeight,
      w: cell.w,
      h: Math.max(0, cell.h - headerHeight),
    };
    return {
      x: cell.x, y: cell.y, w: cell.w, h: cell.h,
      theme: cell.node.theme,
      total: cell.node.kids.reduce((s, k) => s + tierWeight(k.tier), 0),
      items: squarify(
        cell.node.kids.map(k => ({ value: tierWeight(k.tier), node: k })),
        inner),
    };
  });
}
