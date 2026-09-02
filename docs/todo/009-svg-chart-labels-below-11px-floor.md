---
id: 009
title: SVG chart labels use raw font sizes below the panel's 11px floor
status: open
opened: 2026-09-02
owner: unassigned
closed:
---

## Problem

The panel design-system plan sets a hard floor: "Minimum font size: 11px. No
`text-[10px]` or smaller anywhere." That rule was written — and is enforced
by `test/type-scale.test.ts` and `npm run validate:palette` — for the
Tailwind type-scale tokens (`--text-meta`, `--text-label`, etc.) used in
ordinary DOM text. It has never been applied to the raw `fontSize` values
hand-set on `<text>` elements inside this codebase's hand-rolled SVG charts,
and several sit well under 11:

| File | `<text>` | `fontSize` |
|---|---|---|
| `components/arc-gauge.tsx:73` | tick labels | `"6.5"` |
| `components/arc-gauge.tsx:91` | sub-label under the gauge value | `"7"` |
| `components/horizon-strip.tsx:111,123,128,135` | axis / lane labels | `"10"` (all four) |
| `components/spot-chart.tsx:114` | price-level label | `"10"` |
| `components/map-tiles.tsx:67,197-198` | tile headline text | `LABEL_FONT = 10` |
| `components/market-map.tsx:61,122` | tile header text | `HEADER_FONT = 9` |
| `components/technical-map.tsx:40,114` | tile header text | `HEADER_FONT = 9` |
| `components/prediction-panel.tsx:66,69,72` | axis labels | `"9"` (all three) |
| `components/news-flow.tsx:63,94,108-109` | axis / bar labels | `"10"` (all three) |

(`components/arc-gauge.tsx:89` at `"17"` and `components/spot-chart.tsx:98,105`
at `"11"` already clear the floor and are not part of this item.)

## Why it matters

These are chart labels a desk reader on a phone actually has to read —
tile headlines in the fundamental/technical treemaps, axis values on the
spot chart and news-volume chart, the horizon strip's lane labels. If any
of them render under 11px on a real device, they fail the same legibility
floor every other piece of text in this codebase is held to, and nothing
currently checks for it.

## Why this is deferred rather than fixed inline

The 11px rule as written and enforced (`test/type-scale.test.ts`) is a rule
about **rendered** CSS pixels, checked via `getComputedStyle` in
`e2e/mobile.spec.ts`'s type-scale test. SVG `fontSize` is not that: every
chart above sits in a `viewBox`-scaled coordinate system and is stretched to
fill a responsive container (`ResponsiveContainer`-style width, or an
explicit `%`-width wrapper), so a `fontSize="10"` unit in source is not 10
rendered CSS pixels — it could render larger or smaller depending on the
ratio between the `viewBox` width and the element's actual displayed width,
which itself changes with viewport width, panel width, and (per the type
scale's own mobile step-up, see `app/globals.css`) which breakpoint is
active.

Applying the flat "11px minimum" rule to these values without first
measuring each chart's actual `viewBox`-to-rendered-width scale factor (at
both the mobile and desktop breakpoints, since layouts differ) would either
under-fix (raise the source number but still render under 11px on some
width) or over-fix (raise it more than needed, crowding tightly-packed
labels like the treemap tile headers or the horizon strip's lane labels,
which are deliberately compact). That measurement is a real task, not a
find-and-replace, which is why it wasn't done inline while fixing the DOM
text floor.

## Evidence

Checked directly against source, 2026-09-02 (see the table above for exact
line numbers and values — grepped `fontSize=` and the two named constants
across all eight files, cross-referenced against the type-scale plan
constraint in `docs/superpowers/plans/2026-09-01-panel-design-system.md:20`).
Not yet measured: actual rendered px size of any of these labels at any
viewport width — that measurement is exactly what Fix, below, calls for.

## Fix

For each file: measure the chart's `viewBox` width against its actual
rendered width at both the mobile (`<1024px`) and desktop breakpoints (e.g.
via Playwright, reading `getBoundingClientRect()` on the `<svg>` and
comparing to its `viewBox` attribute, the same technique
`e2e/mobile.spec.ts`'s type-scale test already uses for DOM text), compute
the effective scale factor, and raise any `fontSize` whose *rendered* size
falls under 11px — not necessarily every listed value, since some may
already clear the floor once the scale factor is accounted for. Re-check
layout after any increase (treemap tile headers and the horizon strip's lane
labels are tightly packed and a larger font may need truncation-width or
spacing adjustments alongside it — see `map-tiles.tsx`'s
`truncateForWidth`, which already exists for exactly this kind of
trade-off).

## Done when

- Every `<text>` element across the eight files above is confirmed (by
  measurement, not by eyeballing the source number) to render at or above
  11px at both the mobile and desktop breakpoints, or is deliberately left
  smaller with a comment explaining why that specific label is exempt.
- A regression test (Playwright, following the pattern in
  `e2e/mobile.spec.ts`'s "the type scale's mobile step-up is a real
  rendered increase" test) pins the measured rendered size for at least the
  tightest cases (arc-gauge's `6.5`/`7`, the map tiles' `9`/`10`), so a
  future edit to a `viewBox` or container width can't silently shrink these
  again without a test failing.

## Related

- `docs/superpowers/plans/2026-09-01-panel-design-system.md:20` — the 11px
  floor constraint.
- `test/type-scale.test.ts`, `e2e/mobile.spec.ts` — how the floor is
  enforced for ordinary DOM text; the pattern to extend to SVG.
- `.superpowers/sdd/2026-09-01-panel-design-system/final-fix-report.md` —
  the review pass that filed this item.
