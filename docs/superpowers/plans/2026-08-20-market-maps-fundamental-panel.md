# Market Maps — Fundamental Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the fundamental market map on the Jamasp panel — a two-level squarified treemap where tile area is materiality tier and tile colour is direction for gold scaled by conviction — reading the `item_scores` data that is already accumulating on the host.

**Architecture:** A pure derivation module (`lib/marketmap.ts`) turns scored rows into laid-out rectangles; a server-rendered SVG component draws them. No client components, no charting library — the same choice `components/sparkline.tsx` documents. The window is a URL search param, so the page stays server-rendered and the panel's read-only-DB contract is untouched.

**Tech Stack:** Next.js 16.2.12 (App Router), React server components, TypeScript, better-sqlite3 (readonly), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-market-maps-design.md` — §1 (fundamental encoding and coverage) and §4 (the panel) are binding.

## Global Constraints

- **No new dependencies.** The panel already has what this needs.
- **`panel/AGENTS.md`: "This is NOT the Next.js you know."** This is Next.js 16.2.12; APIs and conventions may differ from training data. **Read the relevant guide in `panel/node_modules/next/dist/docs/` before writing any App Router code**, particularly for `searchParams` in a server component — its shape changed across recent majors and guessing here produces code that builds but misbehaves.
- **The panel reads the database read-only and performs every write through the `jamasp` CLI.** This plan adds only reads. The window toggle is a URL param, not a write.
- **Server components only.** No `"use client"`. Hover is a native SVG `<title>`.
- **Two read-time guards are mandatory** (spec §1 "Coverage"), and both belong in the reader:
  1. **Collapse on URL, keeping the highest tier.** One URL can hold several item ids under rewritten headlines (`docs/todo/002`). On a treemap that is arithmetic, not cosmetics: six tiles for one story is six times the area in that theme.
  2. **Reject `published_at` before year 2000.** Pre-`#16` epoch-parsing artefacts; excluded from the window entirely.
- **Multipliers are 1.0.** The learned weights are a later plan. Structure the code so a multiplier slots in without reshaping anything, but do not invent a source for one now.
- **Palette is fixed and measured** — do not substitute values:
  `--map-bull:#1baf7a`, `--map-bull-mid:#3e6d55`, `--map-neutral:#3a3a38`, `--map-bear-mid:#854741`, `--map-bear:#e34948`.
  The pair measures **ΔE 6.9** under deuteranopia — inside the floor band, legal **only** with secondary encoding. The 45° hatch on bearish tiles is that encoding and is **not optional**.
- Tests run from `panel/` with `npm test` (vitest). Baseline is the current suite, green.

---

### Task 1: `lib/marketmap.ts` — tier weight and colour encoding

**Files:**
- Create: `panel/lib/marketmap.ts`
- Test: `panel/test/marketmap.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type ScoredItem = { itemId: string; tier: number; direction: number; conviction: number; theme: string; headline: string; source: string; url: string; publishedAt: string }`
  - `TIER_WEIGHT: Record<number, number>`
  - `tierWeight(tier: number): number`
  - `type Tone = "bull" | "bull-mid" | "neutral" | "bear-mid" | "bear"`
  - `tone(direction: number, conviction: number): Tone`
- Tasks 2, 3, 4 all consume these.

- [ ] **Step 1: Write the failing tests**

Create `panel/test/marketmap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tierWeight, tone } from "../lib/marketmap";

describe("tierWeight", () => {
  it("maps the configured tier scale", () => {
    expect([5, 4, 3, 2, 1].map(tierWeight)).toEqual([100, 60, 30, 10, 3]);
  });

  it("falls back to the lowest weight for an unknown tier", () => {
    // A tier outside 1-5 should occupy space, not vanish or throw: the item
    // was scored, so it is news. Sizing it as noise is the safe reading.
    expect(tierWeight(0)).toBe(3);
    expect(tierWeight(9)).toBe(3);
  });
});

describe("tone", () => {
  it("returns the pole when direction and conviction are both strong", () => {
    expect(tone(2, 0.8)).toBe("bull");    // s = +0.80
    expect(tone(-2, 0.8)).toBe("bear");   // s = -0.80
  });

  it("returns the mid step for a moderate signed intensity", () => {
    expect(tone(1, 0.6)).toBe("bull-mid");   // s = +0.30
    expect(tone(-1, 0.6)).toBe("bear-mid");  // s = -0.30
  });

  it("returns neutral when conviction collapses the intensity", () => {
    // A tier-5 story nobody can call must render big and GREY. This is the
    // spec's stated intent, not an edge case.
    expect(tone(2, 0.1)).toBe("neutral");  // s = +0.10
  });

  it("returns neutral for direction 0 at any conviction", () => {
    expect(tone(0, 0.9)).toBe("neutral");
    expect(tone(0, 0.0)).toBe("neutral");
  });

  it("pins the step boundaries exactly", () => {
    // Boundaries are 0.15 and 0.55 on |s|; both are inclusive-low.
    expect(tone(1, 0.30)).toBe("bull-mid");   // s = 0.150 -> mid, not neutral
    expect(tone(1, 0.29)).toBe("neutral");    // s = 0.145
    expect(tone(2, 0.55)).toBe("bull");       // s = 0.550 -> pole, not mid
    expect(tone(2, 0.54)).toBe("bull-mid");   // s = 0.540
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `panel/`: `npm test -- marketmap`
Expected: FAIL — cannot resolve `../lib/marketmap`.

- [ ] **Step 3: Write the encoding module**

Create `panel/lib/marketmap.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- marketmap`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/lib/marketmap.ts panel/test/marketmap.test.ts
git commit -m "feat(panel): market-map tier weight and diverging colour encoding"
```

---

### Task 2: `lib/marketmap.ts` — squarified treemap layout

**Files:**
- Modify: `panel/lib/marketmap.ts`
- Test: `panel/test/marketmap.test.ts`

**Interfaces:**
- Consumes: `ScoredItem`, `tierWeight` (Task 1)
- Produces:
  - `type Rect = { x: number; y: number; w: number; h: number }`
  - `type Cell<T> = Rect & { node: T }`
  - `squarify<T>(nodes: { value: number; node: T }[], rect: Rect): Cell<T>[]`
  - `type ThemeBox = Rect & { theme: string; items: Cell<ScoredItem>[]; total: number }`
  - `layoutMap(items: ScoredItem[], rect: Rect, headerHeight: number): ThemeBox[]`
- Task 4 consumes `layoutMap` and `ThemeBox`.

- [ ] **Step 1: Write the failing tests**

Append to `panel/test/marketmap.test.ts`:

```ts
import { layoutMap, squarify, type ScoredItem } from "../lib/marketmap";

const RECT = { x: 0, y: 0, w: 400, h: 300 };

function item(over: Partial<ScoredItem> = {}): ScoredItem {
  return {
    itemId: "a", tier: 3, direction: 1, conviction: 0.5, theme: "geopolitics",
    headline: "h", source: "s", url: "u", publishedAt: "2026-08-19T12:00:00Z",
    ...over,
  };
}

describe("squarify", () => {
  it("fills the rectangle exactly and never overlaps", () => {
    const cells = squarify(
      [4, 3, 2, 1].map((v, i) => ({ value: v, node: `n${i}` })), RECT);
    expect(cells).toHaveLength(4);
    const area = cells.reduce((s, c) => s + c.w * c.h, 0);
    expect(area).toBeCloseTo(RECT.w * RECT.h, 4);
    for (const c of cells) {
      expect(c.x).toBeGreaterThanOrEqual(RECT.x - 1e-6);
      expect(c.y).toBeGreaterThanOrEqual(RECT.y - 1e-6);
      expect(c.x + c.w).toBeLessThanOrEqual(RECT.x + RECT.w + 1e-6);
      expect(c.y + c.h).toBeLessThanOrEqual(RECT.y + RECT.h + 1e-6);
    }
  });

  it("allocates area proportional to value", () => {
    const cells = squarify(
      [{ value: 3, node: "big" }, { value: 1, node: "small" }], RECT);
    const big = cells.find(c => c.node === "big")!;
    const small = cells.find(c => c.node === "small")!;
    expect((big.w * big.h) / (small.w * small.h)).toBeCloseTo(3, 4);
  });

  it("gives a single node the whole rectangle", () => {
    const [c] = squarify([{ value: 7, node: "only" }], RECT);
    expect([c.x, c.y, c.w, c.h]).toEqual([0, 0, 400, 300]);
  });

  it("returns nothing for empty input or a zero-area rectangle", () => {
    expect(squarify([], RECT)).toEqual([]);
    expect(squarify([{ value: 1, node: "x" }], { x: 0, y: 0, w: 0, h: 10 }))
      .toEqual([]);
  });

  it("drops zero-value nodes rather than emitting zero-area cells", () => {
    // A zero-area rect would render as an invisible tile that still catches
    // a hover target. Better to omit it.
    const cells = squarify(
      [{ value: 5, node: "a" }, { value: 0, node: "b" }], RECT);
    expect(cells.map(c => c.node)).toEqual(["a"]);
  });
});

describe("layoutMap", () => {
  it("groups items into theme boxes sized by summed tier weight", () => {
    const boxes = layoutMap([
      item({ itemId: "1", theme: "rates_dollar", tier: 4 }),
      item({ itemId: "2", theme: "rates_dollar", tier: 4 }),
      item({ itemId: "3", theme: "geopolitics", tier: 3 }),
    ], RECT, 0);
    const rates = boxes.find(b => b.theme === "rates_dollar")!;
    const geo = boxes.find(b => b.theme === "geopolitics")!;
    expect(rates.total).toBe(120);  // 60 + 60
    expect(geo.total).toBe(30);
    expect((rates.w * rates.h) / (geo.w * geo.h)).toBeCloseTo(4, 3);
  });

  it("omits themes with no items entirely", () => {
    // physical_cb and etf_flows were both empty on the first live day. An
    // empty box would claim area and read as "nothing happened here" rather
    // than "nothing was filed here".
    const boxes = layoutMap([item({ theme: "geopolitics" })], RECT, 0);
    expect(boxes.map(b => b.theme)).toEqual(["geopolitics"]);
  });

  it("reserves the header strip so tiles never sit under the label", () => {
    const [box] = layoutMap([item()], RECT, 14);
    for (const c of box.items) {
      expect(c.y).toBeGreaterThanOrEqual(box.y + 14 - 1e-6);
      expect(c.y + c.h).toBeLessThanOrEqual(box.y + box.h + 1e-6);
    }
  });

  it("returns an empty layout for no items", () => {
    expect(layoutMap([], RECT, 14)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- marketmap`
Expected: FAIL — `squarify` and `layoutMap` are not exported.

- [ ] **Step 3: Implement the layout**

Append to `panel/lib/marketmap.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- marketmap`
Expected: PASS.

- [ ] **Step 5: Run the full panel suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add panel/lib/marketmap.ts panel/test/marketmap.test.ts
git commit -m "feat(panel): squarified two-level treemap layout for the market map"
```

---

### Task 3: `db.getScoredItems` — the reader, with both coverage guards

**Files:**
- Modify: `panel/lib/db.ts`
- Test: `panel/test/db-marketmap.test.ts`

**Interfaces:**
- Consumes: `ScoredItem` (Task 1)
- Produces: `db.getScoredItems(sinceIso: string): ScoredItem[]` — collapsed on URL, `published_at` floor applied, newest first.
- Task 5 consumes it.

**Read `panel/test/db-news.test.ts` first** for how this suite builds a temporary database; follow that pattern rather than inventing one.

- [ ] **Step 1: Write the failing tests**

Create `panel/test/db-marketmap.test.ts`. This follows `test/db-news.test.ts`'s pattern exactly — its own temp root, its own `JAMASP_ROOT`, a dynamic `import("../lib/db")` after the env var is set:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Own fixture root, like db-news.test.ts: the map reader needs a URL-collision
 * shape and an implausible date that no other fixture carries. vitest isolates
 * files into separate workers, so each import of lib/db binds its own root.
 */
let db: typeof import("../lib/db");

const item = (id: string, url: string, publishedAt: string, headline: string) =>
  `('${id}','reuters','${publishedAt}','${headline}',NULL,'${url}','gold',NULL,` +
  `'${publishedAt}',NULL)`;

const score = (id: string, tier: number, dir: number, conv: number, theme: string) =>
  `('${id}',${tier},${dir},${conv},'${theme}','2026-08-19T22:00:00Z')`;

beforeAll(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jamasp-db-marketmap-"));
  mkdirSync(path.join(root, "state"), { recursive: true });
  const d = new Database(path.join(root, "state", "jamasp.db"));
  d.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, source TEXT NOT NULL,
      published_at TEXT NOT NULL, headline TEXT NOT NULL, lede TEXT,
      url TEXT NOT NULL, topic TEXT NOT NULL, cluster_id TEXT,
      fetched_at TEXT NOT NULL, read_at TEXT);
    CREATE TABLE item_scores (item_id TEXT PRIMARY KEY, tier INTEGER NOT NULL,
      direction INTEGER NOT NULL, conviction REAL NOT NULL, theme TEXT NOT NULL,
      scored_at TEXT NOT NULL);
    INSERT INTO items VALUES
      ${item("w1", "https://x.test/w1", "2026-08-19T20:00:00Z", "Late story")},
      ${item("w2", "https://x.test/w2", "2026-08-19T18:00:00Z", "Earlier story")},
      ${item("old", "https://x.test/old", "2026-08-01T12:00:00Z", "Outside window")},
      ${item("dupA", "https://x.test/dup", "2026-08-19T19:00:00Z", "Gold at 4400")},
      ${item("dupB", "https://x.test/dup", "2026-08-19T19:05:00Z", "Gold at 4450 now")},
      ${item("dupC", "https://x.test/dup", "2026-08-19T19:10:00Z", "Gold RSI 77")},
      ${item("bogus", "https://x.test/bogus", "1786-08-01T00:00:00Z", "Epoch artefact")};
    INSERT INTO item_scores VALUES
      ${score("w1", 4, 2, 0.8, "rates_dollar")},
      ${score("w2", 3, -1, 0.6, "rates_dollar")},
      ${score("old", 5, 2, 0.9, "geopolitics")},
      ${score("dupA", 2, 1, 0.3, "other")},
      ${score("dupB", 4, 1, 0.5, "other")},
      ${score("dupC", 3, 0, 0.2, "other")},
      ${score("bogus", 5, 2, 0.9, "geopolitics")};
  `);
  d.close();
  process.env.JAMASP_ROOT = root;
  db = await import("../lib/db");
});

const SINCE = "2026-08-19T00:00:00Z";

describe("getScoredItems", () => {
  it("returns items inside the window, newest first", () => {
    const rows = db.getScoredItems(SINCE);
    expect(rows.map(r => r.itemId)).toEqual(["w1", "dupC", "w2"]);
  });

  it("excludes items published before the window", () => {
    expect(db.getScoredItems(SINCE).some(r => r.itemId === "old")).toBe(false);
  });

  it("collapses three ids sharing one URL into a single highest-tier row", () => {
    // docs/todo/002: a publisher rewriting a live headline mints a new item id
    // for a URL already posted. Three tiles for one story is three times the
    // area in its theme, which then biases the fit. dupB carries tier 4.
    const rows = db.getScoredItems(SINCE);
    const dup = rows.filter(r => r.url === "https://x.test/dup");
    expect(dup).toHaveLength(1);
    expect(dup[0].tier).toBe(4);
  });

  it("rejects an implausible published_at even when the window would admit it", () => {
    // The year-2000 floor is defensive: with any realistic window start, a
    // pre-2000 date is already excluded by the window filter itself, since
    // ISO strings compare lexically. Passing an ancient window start is what
    // makes this test able to fail if the floor is ever removed.
    const rows = db.getScoredItems("1000-01-01T00:00:00Z");
    expect(rows.some(r => r.itemId === "bogus")).toBe(false);
    expect(rows.some(r => r.itemId === "old")).toBe(true);
  });

  it("carries the fields the map needs", () => {
    const [first] = db.getScoredItems(SINCE);
    expect(first).toMatchObject({
      itemId: "w1", tier: 4, direction: 2, conviction: 0.8,
      theme: "rates_dollar", source: "reuters", headline: "Late story",
    });
  });

  it("returns an empty array when the window holds nothing", () => {
    // The component renders an empty state; it must not receive undefined.
    expect(db.getScoredItems("2030-01-01T00:00:00Z")).toEqual([]);
  });
});
```

**Note on the fourth test.** It documents a real property of the guard rather than pretending the guard is load-bearing here: with any realistic window it is unreachable, because `'1786-…' < '2026-…'` lexically. It is kept because this reader is not the only future caller — the learning-loop plan scans all history, where the floor does matter — and because it costs one SQL predicate. If a reviewer flags it as dead code, that reading is defensible; the test is what makes the decision visible either way.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- db-marketmap`
Expected: FAIL — `getScoredItems` is not exported.

- [ ] **Step 3: Implement the reader**

Add to `panel/lib/db.ts`, following the existing `q(...)` wrapper style:

```ts
/**
 * Scored news for the fundamental map, with both coverage guards applied.
 *
 * Guard 1 — collapse on URL. rss.item_id() hashes (source, url, headline),
 * so a publisher rewriting a live article's headline mints a new item for a
 * URL already seen (docs/todo/002). On a treemap that is arithmetic, not
 * cosmetics: six tiles for one story is six times the area in its theme.
 * Highest tier wins, because the strongest read of a story is the one the
 * desk should see.
 *
 * Guard 2 — reject implausible dates. Feeds carrying a raw Unix epoch had it
 * parsed as a year before #16, so "1786971720" became 1786-08-01. Those rows
 * would silently fall outside every window; excluding them explicitly means
 * the coverage count can state how many were dropped.
 *
 * Collapsing happens on read, never on write: item_scores keeps one row per
 * item, and folding on the way in would destroy information that cannot be
 * recovered.
 */
export function getScoredItems(sinceIso: string): ScoredItem[] {
  return q(db => db.prepare(`
    SELECT s.item_id AS itemId, s.tier, s.direction, s.conviction, s.theme,
           i.headline, i.source, i.url, i.published_at AS publishedAt
      FROM item_scores s
      JOIN items i ON i.id = s.item_id
     WHERE i.published_at >= ?
       AND i.published_at >= '2000-01-01T00:00:00Z'
       AND s.tier = (
             SELECT MAX(s2.tier) FROM item_scores s2
               JOIN items i2 ON i2.id = s2.item_id
              WHERE i2.url = i.url)
     GROUP BY i.url
     ORDER BY i.published_at DESC
  `).all(sinceIso) as ScoredItem[]);
}
```

Import `ScoredItem` from `./marketmap` at the top of `db.ts`.

**Verify the collapse actually works before moving on.** `GROUP BY i.url` combined with the `MAX(tier)` subquery is the mechanism; if two rows share both a URL and the max tier, SQLite picks one arbitrarily, which is acceptable (they are the same story at the same tier) but must not produce two rows. Your test for the collapse case is what proves this.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- db-marketmap`
Expected: PASS.

- [ ] **Step 5: Run the full panel suite and commit**

```bash
npm test
git add panel/lib/db.ts panel/test/db-marketmap.test.ts
git commit -m "feat(panel): scored-item reader with URL collapse and date-sanity guards"
```

---

### Task 4: `components/market-map.tsx` — the SVG component

**Files:**
- Create: `panel/components/market-map.tsx`
- Modify: `panel/app/globals.css` (palette tokens)
- Test: `panel/test/market-map.test.tsx`

**Interfaces:**
- Consumes: `layoutMap`, `ThemeBox`, `tone`, `ScoredItem` (Tasks 1-2)
- Produces: `<MarketMap items={ScoredItem[]} width={number} height={number} window={"today" | "week"} coverage={{ scored: number; unscored: number }} />`
- Task 5 renders it.

**Read `panel/components/sparkline.tsx` first** — it documents why these are server-rendered inline SVG rather than a charting library, and this component follows the same rule.

- [ ] **Step 1: Add the palette tokens**

In `panel/app/globals.css`, beside the existing `--viz-*` tokens, add — with a comment recording the measurement, because the hatch below depends on it:

```css
/* Market-map diverging ramp. Two hues + a neutral GREY midpoint (never a
   hue at the midpoint). Measured with the dataviz validator against this
   panel's own surfaces: the pair separates by only dE 6.9 under
   deuteranopia — inside the 6-8 floor band, which is legal ONLY with a
   secondary encoding. The 45-degree hatch on bearish tiles is that
   encoding, and it is required, not decoration: it works at any tile size,
   which a signed number label does not. */
--map-bull: #1baf7a;
--map-bull-mid: #3e6d55;
--map-neutral: #3a3a38;
--map-bear-mid: #854741;
--map-bear: #e34948;
```

- [ ] **Step 2: Write the failing tests**

Create `panel/test/market-map.test.tsx`, following the `renderToStaticMarkup` pattern of `test/fundamental-panel.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketMap } from "../components/market-map";
import type { ScoredItem } from "../lib/marketmap";

function item(over: Partial<ScoredItem> = {}): ScoredItem {
  return {
    itemId: "a", tier: 4, direction: 2, conviction: 0.8, theme: "rates_dollar",
    headline: "Gold jumps as Treasury buyback plans push yields lower",
    source: "investing_commodities", url: "https://x/1",
    publishedAt: "2026-08-19T18:46:13Z", ...over,
  };
}

const render = (items: ScoredItem[]) => renderToStaticMarkup(
  <MarketMap items={items} width={800} height={500} window="today"
    coverage={{ scored: items.length, unscored: 0 }} />);

describe("MarketMap", () => {
  it("renders one rect per item and names the theme", () => {
    const html = render([item(), item({ itemId: "b", theme: "geopolitics" })]);
    expect(html.match(/<rect/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Rates &amp; dollar");
    expect(html).toContain("Geopolitics");
  });

  it("hatches bearish tiles and leaves bullish ones unhatched", () => {
    // The hatch is what makes the dE 6.9 pair legal. If this regresses the
    // palette becomes non-compliant, so the test is a compliance guard.
    const bear = render([item({ direction: -2, conviction: 0.8 })]);
    expect(bear).toContain("url(#map-hatch)");
    const bull = render([item({ direction: 2, conviction: 0.8 })]);
    expect(bull).not.toContain("url(#map-hatch)");
  });

  it("gives every tile a title carrying the full headline and its scores", () => {
    const html = render([item()]);
    expect(html).toContain("<title>");
    expect(html).toContain("Gold jumps as Treasury buyback");
    expect(html).toContain("tier 4");
    expect(html).toContain("investing_commodities");
  });

  it("renders the legend, including the hatch and neutral keys", () => {
    const html = render([item()]);
    expect(html.toLowerCase()).toContain("bearish");
    expect(html.toLowerCase()).toContain("bullish");
  });

  it("states coverage rather than implying completeness", () => {
    const html = renderToStaticMarkup(
      <MarketMap items={[item()]} width={800} height={500} window="today"
        coverage={{ scored: 1, unscored: 7 }} />);
    expect(html).toContain("7");
  });

  it("renders an empty state instead of an empty box", () => {
    const html = render([]);
    expect(html.match(/<rect/g) ?? []).toHaveLength(0);
    expect(html.toLowerCase()).toContain("no scored");
  });
});
```

- [ ] **Step 3: Run to verify failure, then implement**

Run: `npm test -- market-map`
Expected: FAIL — module not found.

Then write `panel/components/market-map.tsx`. Requirements, all pinned by the tests above:

- A single `<svg viewBox="0 0 {width} {height}">`, server-rendered, no `"use client"`.
- `<defs>` containing `<pattern id="map-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">` with a low-opacity black line — applied as a **second** `<rect>` over bearish tiles only, so fill and hatch compose.
- Theme labels in the reserved header strip, uppercase, letter-spaced, in muted ink — human labels (`Rates & dollar`, `Geopolitics`, `Physical / CB`, `ETF flows`, `Supply & mining`, `Other`), not raw slugs.
- **Below a size threshold a tile keeps its rectangle and drops its label.** Never clipped text. Pick the threshold from the rendered box, and state it in a comment.
- Every tile carries `<title>` with headline, tier, direction, conviction, source and age.
- A legend: the five-step ramp with bearish/bullish ends labelled, plus "hatched = bearish".
- A coverage line stating the item count, the window, and the unscored count.
- Text colour must contrast against its own tile fill — dark ink on the bright poles, light ink on the mid and neutral steps. Do not use one ink for all five.

- [ ] **Step 4: Run the tests, then the suite, then commit**

```bash
npm test -- market-map
npm test
git add panel/components/market-map.tsx panel/app/globals.css panel/test/market-map.test.tsx
git commit -m "feat(panel): market-map SVG component with mandatory bearish hatch"
```

---

### Task 5: Page wiring, window toggle, and deploy

**Files:**
- Modify: `panel/app/page.tsx`
- Test: `panel/test/market-map.test.tsx` (window helper only)

**Interfaces:**
- Consumes: everything above.
- Produces: the map rendered as the page hero.

- [ ] **Step 1: Read the Next.js docs for `searchParams`**

**Do this before writing any page code.** `panel/AGENTS.md` warns this is not the Next.js in your training data, and `searchParams`' shape in a server component changed across recent majors — sync object versus promise. Read the App Router page guide in `panel/node_modules/next/dist/docs/` and follow what it says for **this** version. Getting it wrong compiles and then misbehaves at runtime, which no test here would catch.

- [ ] **Step 2: Wire the map into the page**

In `panel/app/page.tsx`:

- Read the window from the search param: `?w=week` selects the trailing 7 days; anything else (including absent) is **today**, meaning since Dubai midnight. Dubai is UTC+4 with no DST — the repo already relies on that fixed offset in `jamasp/flashtext.py`, so compute it the same way rather than adding a tz dependency.
- Call `db.getScoredItems(windowStartIso)`.
- Compute the unscored count for coverage: items published inside the same window with no `item_scores` row.
- Render `<MarketMap>` **above** the existing content, per the spec's layout decision. Nothing currently on the page is removed.
- Render the two window options as plain `<Link>`s (`?w=today` / `?w=week`) with the active one marked. Not a client toggle — it is a view change, and keeping it a link keeps the page server-rendered.

- [ ] **Step 3: Verify locally**

```bash
cd panel && npm run build
```
Expected: build succeeds with no type errors.

Then check both windows render:
```bash
npm run dev &
sleep 6
curl -s "http://127.0.0.1:3000/?w=today" | grep -c "map-hatch\|Rates" 
curl -s "http://127.0.0.1:3000/?w=week" | grep -c "map-hatch\|Rates"
kill %1
```
Both should be non-zero. If the local database has no scored items, seed a few rows first or point at a copy of the host database — a green build against an empty table proves nothing about the render.

- [ ] **Step 4: Commit**

```bash
git add panel/app/page.tsx
git commit -m "feat(panel): fundamental map as the overview hero, with a today/week window"
```

- [ ] **Step 5: Deploy and verify on the host**

The panel is a built Next.js app; a `git pull` that touches `panel/` **requires a rebuild and restart** or the running process keeps serving the old bundle.

```bash
ssh jamasp 'sudo -u jamasp -i bash -lc "cd ~/Jamasp && git pull --ff-only"'
ssh jamasp 'sudo -u jamasp -i bash -lc "cd ~/Jamasp/panel && npm ci && npm run build"'
ssh jamasp 'systemctl restart jamasp-panel && sleep 3 && systemctl is-active jamasp-panel'
```

Verify the map actually rendered — **do not use the runbook's `grep "Last ingest"` check, which is stale and returns a false negative** (it predates the overview redesign; that string no longer exists):

```bash
ssh jamasp 'curl -s http://127.0.0.1:3300/ | grep -c "map-hatch"'
```
A non-zero count means the map's hatch pattern is in the served HTML — that is, the component rendered with real data. Also confirm the page still carries the pre-existing panels (`Technical`, `Drivers`, `Horizon`) so the hero addition did not displace them.

---

## Done when

- `npm test` passes in `panel/`.
- `npm run build` succeeds.
- `https://jamasp.mahdanian.xyz` shows the fundamental map above the existing panels, with real scored news in it.
- Both `?w=today` and `?w=week` render.

## Deliberately not in this plan

- **The technical map.** Its colour is each signal's state in [-1,+1], and that classification layer is `jamasp/signals.py`, which the learning-loop plan builds. The component here is written so the technical map is the same component with different inputs, but it cannot render until those states exist.
- **Learned multipliers.** Every theme is weighted 1.0. The ridge fit is the next plan; when it lands, tile areas rescale with no change to this code beyond multiplying `tierWeight` by the theme's weight.
- Fixing the deploy skill's stale `grep "Last ingest"` health check — noted here, worth its own change.
