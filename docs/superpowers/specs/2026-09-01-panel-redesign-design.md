# Jamasp Panel Redesign — Design Spec

**Date:** 2026-09-01
**Status:** Approved (brainstorming session with Saman)
**Supersedes:** the "Out of scope (v1)" line in
`2026-08-01-jamasp-panel-design.md` that excluded mobile-optimized layouts,
and the Overview page ordering in `2026-08-10-panel-overview-redesign-design.md`.

## Purpose

Give the panel a coherent visual system and a real mobile layer. The panel is
served at `jamasp.mahdanian.xyz` behind Cloudflare Access and is read on
phones; today it is desktop-only by construction. This spec covers the design
system (colour, type, spacing, theme), the application shell, a set of shared
primitives, and the treatment of all nine routes.

## What is wrong today

Measured against the current tree, not assumed.

**Mobile is structurally broken, not merely unpolished.** `app/layout.tsx:13`
places a fixed `w-48` sidebar in a flex row at every viewport, and `main`
carries `overflow-x-hidden`. On a 390pt phone that leaves roughly 150px of
content column and *clips* the overflow rather than scrolling it. The entire
panel contains **19 responsive utilities**: 8 `sm:`, 3 `md:`, 6 `lg:`, 2 `xl:`.

**Touch targets are around half the minimum.** Nav links are `px-3 py-1.5
text-sm` ≈ 30px tall (`components/nav.tsx:20`); the map window toggle is
`px-2 py-0.5` ≈ 22px (`app/page.tsx:181`); `FullscreenButton` is `px-2 py-1
text-xs`; the status-strip run dots are 8px with no padded hit area. The
platform default is 44×44pt with 28×28pt as the floor.

**Seven uses of `text-[10px]`** — the `QuoteTile` label and age line
(`components/quote-tile.tsx:78,96`) and the map legends — sit below the 11pt
mobile minimum.

**The app overrides the system appearance.** `<html className="dark">` is
hardcoded at `app/layout.tsx:11`. The light tokens in `:root` are dead code,
and broken if ever reached: `--primary` gold is defined **only** inside
`.dark`, so light mode silently loses the brand accent to a neutral
`oklch(0.205 0 0)`.

**Persian text has no font.** `app/alerts/page.tsx:47` requests
`[font-family:Vazirmatn,Tahoma,sans-serif]`, but Vazirmatn is never loaded
anywhere in the panel — no `next/font`, no `@font-face`. Every Persian alert
has rendered in Tahoma fallback.

**There is no type scale.** 65 `text-sm`, 55 `text-xs`, 7 `text-[10px]`, then
an unmediated jump to `text-lg` / `text-2xl` / `text-3xl`.

**Surfaces are hand-rolled.** 16 files draw `rounded border border-border` by
hand; exactly **one** file imports `components/ui/card`.

**Depth does not read.** Card-against-background separation measures
**1.10:1** and border-against-background **1.25:1**. The base/elevated
instinct is present in the tokens but nothing perceptible lands.

**Four routes render six-column tables** (`/schedule`, `/crawl`, `/state`,
`/inbox`) inside `overflow-x-auto`, i.e. horizontal scroll nested in a
vertical page on a phone.

### What is *not* wrong, and must survive

The information design is strong and is not up for revision:

- Honest nulls. A missing reference renders `24h —`, never a fabricated flat
  zero (`quote-tile.tsx#Delta`, `spot-delta.test.tsx`).
- No buy/sell verdict, per `config/sources.yaml:283` and the e2e assertion
  that the panel never renders `/strong buy|strong sell|recommend/i`.
- Area as the treemap encoding, with a 45° hatch as the required secondary
  encoding on bearish tiles — deliberate redundancy, not decoration. A
  treemap's tiles vary in size, sit against each other rather than a common
  ground, and are read at a glance; colour alone should not have to carry
  direction under those conditions at any margin.
- The CVD-validated `--viz-*` trio and market-map ramp.
- The `stance.md` parsing decisions, which were verified against ten real
  versions on `origin/live`.

Contrast today is genuinely good and is preserved or improved: dark foreground
18.96:1, muted-foreground 7.63:1, gold 8.82:1, destructive 6.84:1.

## Decisions made

| Question | Decision |
|---|---|
| Visual direction | Deep desk terminal — layered near-black surfaces, gold as identity only, dense tabular figures |
| Mobile strategy | Adaptive: one codebase of pages, components carry real mobile variants; bottom tab bar |
| Theme | Light and dark as peers, following the system, with a manual override |
| Typography | Inter + Vazirmatn, self-hosted via `next/font` |
| Scope | Full IA rethink, desktop Overview included |
| Desktop Overview order | Answer first, evidence below (hero band → panels → maps) |
| Palette discipline | Vendored validator + a test, replacing a referenced script that does not exist |

## Foundation

### Colour

shadcn's semantic token names are kept so `components/ui/*` continues to work
untouched; they are redefined from a surface ladder. New names are additions,
not replacements.

| Role | Token | Dark | Light |
|---|---|---|---|
| Page field | `--background` | `#0a0b0a` | `#f6f6f3` |
| Panel | `--card`, `--popover` | `#161716` | `#ffffff` |
| Raised / inset / hover | `--secondary`, `--muted`, `--accent` | `#242422` | `#eeeeea` |
| Hairline | `--border`, `--input` | `#333330` | `#dedad2` |
| Primary ink | `--foreground` | `#fafafa` | `#14140f` |
| Secondary ink | `--muted-foreground` | `#a1a1a1` | `#5f5f58` |
| Metadata ink (new) | `--ink-dim` | `#8d8d86` | `#69695f` |
| Identity / focus | `--primary`, `--ring` | `#d4a73e` | `#7c5e17` |
| Direction up (new) | `--up` | `#4ade80` | `#12784a` |
| Direction down (new) | `--down` | `#ff6467` | `#c02a28` |

Every ink is measured against **all three surfaces of its own theme**, not
just the panel — the raised/inset surface is the worst case and the one an
eyeballed palette misses.

Dark, worst-surface (raised `#242422`) readings: foreground 14.90:1, muted
6.02:1, `--ink-dim` 4.66:1, gold 6.96:1, up 8.92:1, down 5.38:1. Light,
worst-surface (inset `#eeeeea`): foreground 15.88:1, muted 5.53:1,
`--ink-dim` 4.77:1, gold 5.20:1, up 4.74:1, down 5.01:1. **Every ink clears
4.5:1 on every surface of its theme**; the two worst readings in the system
are 4.66:1 and 4.74:1.

Three values were corrected during this pass after failing that check on the
raised/inset surface specifically: dark `--ink-dim` (`#86867f`, 4.24:1),
light `--ink-dim` (`#6e6e66`, 4.42:1) and light gold (`#8a6a1c`, 4.34:1).
Gold matters because `--primary` colours the active navigation label at body
size, not only the wordmark.

Structure, dark: panel-to-field ΔL\* 4.1, raised-to-panel ΔL\* 7.6, hairline
1.56:1 against the field — against today's 1.10:1 surface step and 1.25:1
hairline.

`--ink-dim` exists so age and provenance lines stop improvising
`text-[10px] text-muted-foreground`.

The `--viz-*` and `--map-*` tokens are **not** hand-edited. They go through
the validator below against both new surfaces. Note that today's light
`--viz-*` trio was validated against `#ffffff`, which remains the light *panel*
colour, so those readings hold; the light page *field* becomes `#f6f6f3`, so
any mark drawn on the field rather than inside a panel is re-checked. The
light market-map ramp is new work — no light variant exists today.

### Type

One scale, expressed in `rem` so browser font-size settings scale it. **No
font-size below 11px anywhere**, which deletes all seven `text-[10px]` uses.

| Token | Desktop | Mobile | Use |
|---|---|---|---|
| `display` | 30px / 600 / tnum | 28px | hero figure |
| `title` | 20px / 600 | 20px | page `h1` |
| `heading` | 15px / 600 | 16px | section `h2` |
| `body` | 13px / 1.5 | 15px | prose, table cells |
| `meta` | 11px | 12px | ages, footnotes |
| `label` | 11px uppercase, 0.1em tracking | 12px | panel labels |

### Theme mechanism

`className="dark"` comes off `<html>`. A pre-paint inline script in
`app/layout.tsx` resolves the appearance from `localStorage.theme`, falling
back to `matchMedia('(prefers-color-scheme: dark)')`, and subscribes to system
changes while in system mode. A three-state control (System / Light / Dark)
lives in the shell header. `<html>` carries `suppressHydrationWarning`.

A `@media (prefers-color-scheme: dark)` block mirrors the dark tokens so a
reader with JavaScript disabled still gets the correct appearance, and the
`localStorage` read is wrapped in `try/catch` for private-browsing contexts
where the accessor throws.

### Fonts

`next/font/google` for Inter (`latin`) and Vazirmatn (`arabic`), bound to
`--font-sans` and `--font-fa`. The bundled Next 16 docs
(`node_modules/next/dist/docs/01-app/01-getting-started/13-fonts.md`) confirm
built-in self-hosting with no external network request, which matters behind
Cloudflare Access.

Figures use `font-feature-settings: "tnum"` through the `Figure` primitive
rather than scattered `tabular-nums` classes. Persian binds via a
`:where([dir="rtl"], [lang="fa"])` rule, which removes the inline
`[font-family:…]` at `app/alerts/page.tsx:47`.

## Shell and navigation

`app/layout.tsx`'s flex row becomes an `AppShell` with two modes at a `lg`
(1024px) breakpoint.

**Desktop, ≥1024px** — `SideNav` at 224px: gold wordmark, a lucide icon and
label per link (lucide is already a dependency), 40px row height, and an
active state marked by a gold left rule **plus** gold text **plus** a raised
background — three cues rather than colour alone. Visible focus ring on
`--ring`.

**Below 1024px** — the sidebar is not rendered:

- `TopBar`, sticky, honouring `env(safe-area-inset-top)`: wordmark, page
  title, a status dot linking to `/alerts` that turns amber or red when
  `deriveWarnings` returns anything, and the theme control.
- `TabBar`, fixed to the bottom, honouring `env(safe-area-inset-bottom)`:
  **Overview · Inbox · Briefs · Schedule · More**. 56px bar, every target
  ≥44×44pt. "More" opens a sheet (radix dialog, already a dependency) holding
  Crawl, Calendar, Alerts, State and Prices.

Alerts sits in the sheet rather than the bar because the top-bar status dot
already routes there, which keeps the alerting path one tap away without
spending a tab slot.

A skip-to-content link and a real `<main id="main">` are added; neither exists
today.

## Primitives

Four components in `components/ui/`, replacing the current situation where 16
files hand-roll surfaces and one imports `Card`.

| Primitive | Replaces | Behaviour |
|---|---|---|
| `Panel` | the 16 hand-rolled surfaces and `Card` | surface-1, hairline, radius; optional `title` / `action` / `footer` slots; `tone` for warn and destructive; an `empty` slot so "no data yet" reads identically everywhere |
| `Figure` | ad-hoc `text-2xl font-semibold` and scattered `tabular-nums` | a number with `tnum`, an optional `Delta`, size variants; preserves the existing tri-state null semantics exactly |
| `DataList` | `ui/table` at every call site | renders `<table>` at container width ≥`@md` and stacked definition-list rows below — a container query, so it adapts to a narrow *column*, not just a narrow device |
| `StatChips` | the ops half of `StatusStrip` | collapsed chips that expand to the full strip on click |

`ui/table` is retained and wrapped by `DataList` rather than deleted.

## Page treatments

**`/` Overview.** Reordered so the first screen answers the question the page
was specced to answer:

```
hero band            price vs. levels · Jamasp's read · weight bar
FUNDAMENTAL          │  TECHNICAL          (two columns at lg)
ops chips            ingest · runs · errors · run-type dots
warning banners      full width, only when non-empty
market map           1200×600, fullscreen control retained
technical map        1200×600, fullscreen control retained
NEWS FLOW            │  DRIVERS + RECORD
footer strip         next wakeup · next event · last alert
```

Nothing is removed; the maps keep full 2:1 fidelity and move below as the
evidence trail. On mobile the order is hero → read → *What's moving* ranked
list → technical → news → chips, where the ranked list is the treemap's
mobile variant (same data, same direction and conviction, rendered as rows)
and a "Map ⤢" control opens the real treemap full-screen.

**`/inbox`.** Search, filters, cluster grouping and infinite scroll are
unchanged. The table becomes `DataList`; filters become a sticky bar that
survives scrolling on a phone; unread stops being colour-only, gaining a gold
left rule and an "unread" label.

**`/briefs`.** Entries group by month and show a real date and title instead
of the raw slug `2026-07-31-brief`. `listReports()` returns only
`{slug, date}`, so `lib/files.ts` gains a `reportTitle()` that reads the head
of each file for its `#` heading rather than the whole document. The reader
page gets a `max-w-[68ch]` prose column.

**`/calendar`.** A day-grouped agenda with today anchored and marked. The
hardcoded `w-40` timestamp column is removed; UTC and Dubai times stack on
mobile. Impact retains its text label alongside the badge colour.

**`/schedule`.** `StatCard` becomes `Figure` inside a `Panel`; both tables
become `DataList`; "Run now" and cancel controls reach ≥44px; the wakeup
history list gains structure.

**`/crawl`.** Table becomes `DataList`. Source state keeps its word — `ok`,
`stale`, `never`, `erroring` — so meaning never rests on badge colour alone.

**`/alerts`.** Tabs are unchanged. Persian messages get `--font-fa` and `dir`
on the container, rendering in Vazirmatn for the first time. Send failure is
marked by icon and text, not only a red badge.

**`/state`.** Stance and playbook get the prose column; the predictions table
becomes `DataList`; the scorecard line becomes `Figure`s.

**`/prices`.** Charts are grouped and labelled by kind — spot, indicators,
cross-asset — instead of an anonymous grid. The existing per-chart range
picker in `components/price-chart.tsx` is untouched.

**`app/error.tsx`.** Restyled onto the token system; it currently hardcodes
`amber-950/50` and siblings.

## Error handling

Every existing empty and degraded state is preserved verbatim — the stance
`degraded` badge, `insufficient data`, `no price data yet`, `24h —`, the
neutral-and-dashed map tiles when `weights.json` is absent. `Panel`'s `empty`
slot only makes their presentation consistent.

New failure modes introduced by this work:

| Condition | Behaviour |
|---|---|
| `localStorage` throws (private browsing) | `try/catch`, fall through to `prefers-color-scheme` |
| JavaScript disabled | `@media (prefers-color-scheme: dark)` block carries the dark tokens |
| Font fetch fails at build | `next/font` metric-adjusted fallback; no layout shift |
| A table placed in a narrow column | `DataList` switches on its own container width, so it stacks correctly even in a wide viewport |

## Validation and testing

### Palette validation becomes code

`globals.css` instructs the reader to "re-run `scripts/validate_palette.js`
from the dataviz skill". **That script does not exist** — not in this repo and
not anywhere under `~/.claude`; the dataviz skill is harness-served with no
local directory. The discipline the comments encode is currently
unenforceable, and this work needs it to clear the light ramp.

`panel/scripts/validate-palette.mjs` is vendored, with
`panel/test/palette.test.ts` parsing the tokens out of `globals.css` and
asserting, for **both** surfaces:

- every ink against **every surface of its theme** — field, panel and
  raised/inset — at ≥4.5:1 for body text and ≥3:1 for large or bold. Checking
  inks against the panel alone is what let three sub-floor values through the
  first pass of this spec, so the cross-product is the assertion, not a
  representative pair.
- adjacent `--viz-*` separation under normal vision and simulated
  deuteranopia, protanopia and tritanopia
- the market-map ramp's pair separation against its floor, with the hatch
  recorded as the required secondary encoding

Token edits then fail CI rather than failing silently.

### Test suites

**vitest** — the existing suites assert text and roles rather than class
names, so they should survive the restyle; any that do break get updated, not
deleted. New suites cover `Panel`, `Figure`, `DataList` (a `<table>` at wide
widths, a definition list at narrow) and the pure theme-resolution function.

**Playwright** — the desktop project is kept, with `/`'s ordering assertions
updated to the new layout. A **second project at 390×844** reuses the same
fixture server on port 3311 and asserts across all nine routes:

- no horizontal overflow (`scrollWidth <= clientWidth`)
- the tab bar is present and the sidebar is absent
- every tab target measures ≥44px
- the ranked-list map variant renders in place of the treemap

## Sequencing

Six phases, each independently verifiable:

1. **Foundation** — the vendored validator and its test first, then tokens
   (including fitting the light market-map ramp against it), type scale,
   theme mechanism and control, fonts. The validator leads the phase because
   the light ramp cannot be settled without it.
2. **Shell** — `AppShell`, `SideNav`, `TopBar`, `TabBar`, More sheet, skip link
3. **Primitives** — `Panel`, `Figure`, `DataList`, `StatChips` and unit tests
4. **Overview** — reorder, hero band, mobile ranked-list variant, fullscreen
5. **Remaining eight pages** — `/briefs` carries the one `lib/files.ts` change
6. **Validation sweep** — e2e updates, full vitest and Playwright runs

Work happens in a git worktree, not a branch on the main checkout.

## Risks

**The light market-map ramp may not clear CVD separation on a white
surface** without hue changes. If it cannot, the resolution is to rotate the
bearish hue toward magenta rather than to lighten toward the surface — the
same ramp has to carry legible ink, so lightening trades a CVD failure for a
contrast failure. The hatch remains mandatory either way. Deciding this needs
the validator, so the light ramp is fitted in phase 1 and not deferred to the
sweep.

*Resolved during execution:* the light poles cleared the 6.0 floor on the
first candidates — ΔE 13.0 deuteranopia, 13.2 protanopia, 59.3 tritanopia. No
hue rotation was needed.

**Correction to an earlier claim in this spec.** Previous drafts asserted the
dark poles separate by "only ΔE 6.9 under deuteranopia — inside the 6–8 floor
band." That figure came from the `globals.css` comment written by the
validator that does not exist, and it is **not reproducible**: measured with
the vendored validator (CIEDE2000, Machado severity 1.0) the same unchanged
pair reads ΔE 12.5. A different ΔE metric or CVD model would explain the gap,
so the old number is unreproducible rather than provably wrong — but it
should never have been repeated here as measured fact. The hatch's
justification does not depend on it, and the hatch stays.

**The Overview reorder changes `e2e/smoke.spec.ts`.** Those assertions are
updated deliberately as part of phase 6, never deleted to reach green.

**`components/ui/*` is shadcn-generated.** Redefining the semantic tokens
rather than the components keeps future shadcn regeneration viable; no
`ui/*` file is edited except where a primitive wraps it.

## Out of scope

- Any change to the agent contract, `CLAUDE.md`, the run skills, the CLI, or
  the Python side. The panel remains a read-only viewer that writes only
  through `jamasp`.
- Any change to `lib/db.ts`, `lib/marketmap.ts`, `lib/technicals.ts`,
  `lib/stance.ts`, `lib/health.ts`, `lib/horizon.ts` or `lib/newsflow.ts`.
  The single library change is `reportTitle()` in `lib/files.ts`.
- New data, new panels, or new routes.
- In-app authentication; the Cloudflare Access boundary is unchanged.
- Chart overlays and the other items deferred by
  `2026-08-10-panel-overview-redesign-design.md`.
