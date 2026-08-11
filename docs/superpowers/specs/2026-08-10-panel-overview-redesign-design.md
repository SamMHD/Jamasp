# Panel Overview Redesign — Design Spec

**Date:** 2026-08-10
**Status:** Approved (brainstorming session with Saman)

## Purpose

Turn the panel's Overview page from a machine-health dashboard into a desk
dashboard. Today it answers "is the agent alive?"; it should answer "what does
Jamasp think right now, and where is gold trading against the levels that
matter?" Machine health stays — it just stops taking the whole page.

Two panels lead the page:

1. **Fundamental** — Jamasp's current read, parsed out of `state/stance.md`,
   with recent headlines beneath as the evidence trail.
2. **Technical** — where spot sits against the levels already in the `prices`
   table, plus the indicator readout.

## What's wrong with the current page

`panel/app/page.tsx` renders four ops stat cards, then **every price symbol in
the database as an identical anonymous `StatCard`** (lines 51–57). In
production that is 19 tiles in which `GC`, `GC_RSI14`, `GC_SMA200`, `^GVZ` and
`BTC-USD` are visually indistinguishable — a spot price, a momentum
oscillator, a moving average, an implied-vol index and an unrelated
cross-asset, all rendered as `label / value / 24h·7d`. The 24h and 7d deltas
are meaningless on an RSI or a moving average, which `jamasp/pricesummary.py`
already knows (see `TECH_SUFFIXES`, "24h/7d deltas on an RSI or a pivot are
noise") but the panel does not.

Below that sit warnings, last runs, next wakeups, next events and the latest
alert — all useful, none of it the market.

## Decisions made

| Question | Decision |
|---|---|
| Fundamental panel content | Jamasp's read from `stance.md`, headlines beneath as evidence |
| How the panel gets structure from `stance.md` | Parse in the panel; **no agent contract change** |
| Preamble handling | Rendered verbatim as markdown — not parsed into bullets |
| Technical panel content | Levels ladder + regime lead; sparkline secondary; no chart overlays |
| Ladder level sources | Database only — no levels scraped from stance prose |
| Regime rule | Ported from `jamasp/pricesummary.py#_tech_line`, not reinvented |
| Buy/sell verdict | **None** — honours `config/sources.yaml:283` |
| Existing ops content | Compact status strip + full-width warnings; nothing deleted |

## Evidence behind the parsing decisions

These were verified against the last 10 real `stance.md` versions on
`origin/live`, not assumed.

**`##` headings are stable.** Across 8 consecutive runs (brief, scan and
deepdive alike) every version carried `## View`, `## What flips me`,
`## Open predictions`, `## Wakeups`, `## Desk-local`, `## Sourcing health`.
Headings do take varying parenthetical suffixes — `## Open predictions
(Friday cohort scores Sat 00:15Z, wakeup #19)`, `## What flips me (pre-CPI)` —
so matching must be by **prefix**, not equality. Ad-hoc extra sections appear
regularly (`## CPI decision tree (tomorrow 12:30Z, wakeup #20)`,
`## Friday cohort scored (04:20 Sat, see 08-08 report)`).

**The preamble is not parseable.** Bold labels in the block between the H1 and
`## View` are improvised every run: `EVENT-PENDING`, `New since Sunday`,
`Saturday`, `Kpler`, `Crowding`, `Mecca pact`, `Fri settle GC 4401.3`,
`The hike case just lost payrolls`. There is no schema. It is rendered
verbatim.

**Text is hard-wrapped at ~72 characters, so regexes must run on unwrapped
text.** How much this bites depends on where the wrap happens to fall, which
shifts run to run. Measured against real history: a line-based search for the
full bolded weights sentence (`**Weights … conviction … .**`) finds it in only
1 of 10 versions, because that span reliably crosses a wrap; a line-based
search for just the triplet and its parenthetical currently finds it in 6 of 6
fixtures, because that shorter span happens to fit on one line each time.
Unwrapping makes both succeed and removes the dependence on wrap position — the
narrow pattern's present luck is not a reason to skip it. The format itself is
consistent: `Weights 70/5/25 (base/event-bearish/kinetic), conviction …`, with
the triplet changing between runs (`65/10/25` on 2026-08-07 scan, `55/20/25` on
the 2026-08-07 deepdive).

**A structured sidecar was considered and rejected.** Having the agent emit
`state/stance.yaml` would require changing CLAUDE.md rule 5 plus the `brief`,
`scan`, `deepdive` and `retro` skills, and the agent would still improvise the
preamble — the most interesting part. Parse what is stable; render the rest.

## Architecture

Unchanged foundations: one `force-dynamic` server component, synchronous
`better-sqlite3` read-only reads plus `node:fs`, existing `AutoRefresh`. The
panel remains a read-only viewer that writes only through the CLI.

### New: `panel/lib/stance.ts`

Pure functions over the raw `stance.md` text. No I/O — `files.readStance()`
already exists and stays the reader.

```ts
export type StanceWeight = { label: string; pct: number };
export type StanceSection = { heading: string; body: string };
export type ParsedStance = {
  asOf: string | null;          // from the H1: "2026-08-10"
  updatedNote: string | null;   // "updated 07:50 Dubai, Monday brief"
  preamble: string;             // H1 -> first "##", raw markdown
  sections: Partial<Record<StanceKey, StanceSection>>;
  extra: StanceSection[];       // unrecognised "##" sections, order preserved
  weights: StanceWeight[] | null;
  raw: string;                  // always present
  degraded: boolean;            // true when no "## View" was found
};
```

- `unwrapParagraphs(text)` — join single newlines within a paragraph into
  spaces; preserve blank lines, list-item boundaries and fenced blocks. Run
  before any regex. This is the single most important function in the module.
- Canonical keys, matched case-insensitively by **prefix** against the heading
  text: `view`, `whatFlipsMe`, `openPredictions`, `wakeups`, `deskLocal`,
  `sourcingHealth`.
- Anything else with a `##` heading lands in `extra[]` and is rendered.
  Sections are never silently dropped.
- `weights` extracted from the `view` body with
  `/Weights\s+(\d+)\/(\d+)\/(\d+)\s*\(([^)]+)\)/i` over unwrapped text,
  zipping the three numbers against the slash-separated labels in the
  parenthetical. Label/number count mismatch yields `null` rather than a
  partial render.
- **Total-failure path:** no `## View` anywhere sets `degraded: true`, and the
  panel renders `raw` through the existing `Markdown` component. No input
  produces a blank panel.

### New: `panel/lib/technicals.ts`

```ts
export type Level = {
  label: string;                // "200DMA", "pivot R1", "spot", "pivot S1", "50DMA"
  value: number;
  kind: "ma" | "pivot" | "spot";
  side: "above" | "below" | "at";
};
export type GoldTechnicals = {
  spot: { value: number; ts: string; delta24h: number | null } | null;
  levels: Level[];              // descending by value, spot included
  regime: string | null;        // null when SMA50/SMA200 unavailable
  indicators: { rsi14: number | null; atr14: number | null;
                gvz: number | null; netSpec: number | null };
  indicatorsAsOf: string | null;
  stale: boolean;               // indicator set older than 12h
};
```

- Reads `GC`, `GC_SMA50`, `GC_SMA200`, `GC_PIV_S1`, `GC_PIV_R1`, `GC_RSI14`,
  `GC_ATR14`, `^GVZ`, `GC_NET_SPEC` via the existing `lib/db.ts` helpers,
  adding a `latestPrices(symbols)` batch helper rather than N round trips.
- `levels` contains only database-sourced values. Levels that appear in stance
  prose (for example "4300 psychological") are deliberately excluded —
  regex-hunting numbers out of narrative is exactly the fragility this design
  avoids elsewhere.
- `regime` is a direct port of `jamasp/pricesummary.py#_tech_line`: `above both`,
  `below both`, `above 50DMA, below 200DMA`, `below 50DMA, above 200DMA`. The
  Python is the reference implementation; the port exists so the panel and the
  Telegram brief can never disagree. A comment in both files points at the
  other.
- `stale`: the `tv_gc_technicals` source runs every 360 minutes, so the
  indicator set older than 12h flags a badge. Real production data shows 33
  indicator points across 9 days — gaps happen and must be visible rather than
  silently rendered as current.
- **No aggregate buy/sell gauge.** `config/sources.yaml:283` records that
  `Recommend.All` is deliberately not stored, because "technicals annotate the
  macro read, they must not originate calls." The panel honours that.

### New components

| Component | Responsibility |
|---|---|
| `status-strip.tsx` | Ingest age, runs today/cap, source errors, four run-type dots; every element links to its detail page |
| `fundamental-panel.tsx` | As-of header, weight chips, preamble, View, What flips me, extra sections, headline list |
| `technical-panel.tsx` | Spot + 24h delta header, ladder, regime line, indicator row, sparkline |
| `level-ladder.tsx` | Purely presentational: sorted levels + spot in, proportionally spaced rows out |
| `sparkline.tsx` | Compact 10-day `GC` line; no axes, no tooltip |

Reused untouched: `deriveWarnings`, `deriveSourceHealth`, `AutoRefresh`,
`Markdown`, `RunBadge`, `PageHeader`.

### Page layout

```
status strip           ingest · runs · errors · brief/scan/deepdive/retro dots
warning banners        full width, existing styling, only when non-empty
─────────────────────────────────────────────────────────────
FUNDAMENTAL            │  TECHNICAL
stance + headlines     │  ladder + regime + indicators
─────────────────────────────────────────────────────────────
footer strip           next wakeup · next event · last alert
```

Two columns at `lg:` and above; stacked below, fundamental first. Wakeups,
events and the latest alert move from full sections into the footer strip;
their detail pages are unchanged.

The `FundamentalPanel` headline list shows the 8 most recent items via
`db.getItems({ limit: 8 })` with source and age, linking to `/inbox`.

## Error handling

Each failure is local to one panel; neither can blank the page.

| Condition | Behaviour |
|---|---|
| `stance.md` missing | Fundamental panel shows "no stance yet"; technical unaffected |
| `stance.md` unparseable | Whole file rendered as markdown, `degraded` badge shown |
| Weights line absent or malformed | Chips omitted; rest of panel renders |
| `GC_SMA200` / `GC_SMA50` missing | Ladder renders available levels; `regime` is `null` and `TechnicalPanel` renders the literal text "insufficient data" |
| No `GC` rows | Technical panel shows "no price data yet" |
| Indicators older than 12h | Ladder renders with a stale badge and the indicator timestamp |
| Zero items | Headline list shows "no items"; stance sections still render |

## Testing

**`panel/test/stance.test.ts`** — fixtures are **real historical `stance.md`
versions extracted from `origin/live` git history**, not hand-written
approximations. At least six, spanning brief, scan and deepdive runs.
Assertions:

- headings match despite parenthetical suffixes (`## Open predictions (Friday
  cohort scores Sat 00:15Z, wakeup #19)` → `openPredictions`)
- weights extracted from every version that contains them, including the
  `65/10/25` variant and versions where the line wraps mid-bold
- unwrapping is required: the same assertion fails against non-unwrapped text
- unknown sections (`CPI decision tree`, `Friday cohort scored`) survive into
  `extra[]` in document order
- garbage input and a stance with no `## View` both degrade to `raw` with
  `degraded: true`
- H1 date and updated-note extraction, including an H1 with no parenthetical

**`panel/test/technicals.test.ts`** — ladder ordering with spot interleaved;
all four regime cases; spot exactly equal to an SMA; missing-indicator
degradation; the 12h staleness boundary either side; empty-prices path.

**Fixture work** — `panel/test/fixtures/root/state/jamasp.db` currently holds
almost no price data. `panel/scripts/build-fixture.mjs` gains the GC technical
series (`GC`, `GC_SMA50`, `GC_SMA200`, `GC_PIV_S1`, `GC_PIV_R1`, `GC_RSI14`,
`GC_ATR14`, `^GVZ`, `GC_NET_SPEC`) with values in production's observed
ranges, plus a stale-indicator variant.

**E2E** — `panel/e2e/smoke.spec.ts` gains an assertion that the overview
renders both panel headings, the ladder, and the status strip.

**Drift guard for the ported regime rule** — asserted on **both** sides, with
symbolic cross-references rather than line numbers.

- `technicals.test.ts` asserts all four regime strings plus the strict-`>`
  boundary.
- `tests/test_pricesummary.py` asserts the same four strings plus the
  boundary. Without this the guard is one-sided: the Python suite originally
  covered only `"below both"`, so rewording `"above both"` or relaxing `>` to
  `>=` left all 221 Python tests green while the desk-facing Telegram brief
  silently diverged from the panel.
- Reciprocal comments in `lib/technicals.ts` and `pricesummary.py` name each
  other as the paired implementation, by symbol (`#deriveRegime`,
  `#_tech_line`) and never by line number — inserting the reciprocal comment
  shifted the Python block and invalidated a line-number citation on its very
  first use.

No cross-language test harness: vitest does not invoke Python. Each suite
pins the same four strings independently.

## Out of scope

Deliberately excluded, to keep this to a single implementation plan:

- Chart overlays (SMA/pivot lines drawn on a price chart). With 441 spot
  points against 33 daily indicator points, overlays render as step functions,
  and ~10 days of history cannot show a meaningful 200DMA relationship.
- A cross-asset driver board (DXY, `^TNX`, real yield, USDJPY, SPX, SGE
  premium). Worth doing later; it is a different panel, not this one.
- Extracting price levels from stance prose.
- Any change to the agent contract, CLAUDE.md, the run skills, or the CLI.
- A separate `/health` page.
- Changes to `/prices`, `/inbox`, `/state`, `/schedule`, `/alerts`,
  `/calendar`, `/briefs`.
