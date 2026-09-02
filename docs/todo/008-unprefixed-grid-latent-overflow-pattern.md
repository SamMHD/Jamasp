---
id: 008
title: Two more grids share the min-content overflow trap that caused the / horizontal-scroll bug
status: open
opened: 2026-09-02
owner: unassigned
closed:
---

## Problem

Task 16 of the panel design-system plan found and fixed a real 115px
horizontal-overflow bug on `/`: `app/page.tsx`'s two-column section grid used
`grid gap-4 lg:grid-cols-5` with no base `grid-cols-*`. Below the `lg:`
breakpoint that leaves `grid-template-columns` unset, so the grid falls back
to a single *implicit* column sized `auto`. CSS Grid's default
`min-width: auto` on grid items lets that `auto` track grow to whichever
child's min/max-content size is largest instead of being clamped to the
container — at 390px the track measured 488.86px, pulling the whole page
along with it (`document.documentElement.scrollWidth: 505` against
`clientWidth: 390`). The fix was adding a base `grid-cols-1`, mirroring what
`lg:grid-cols-5` already implied was intended.

The same shape — an unprefixed `grid` with only a breakpoint-prefixed
`grid-cols`, no base column count — exists in two more places and was never
fixed, because neither currently overflows with the fixture content the E2E
suite exercises:

- `components/technical-panel.tsx:97` —
  `<div className="grid gap-x-6 gap-y-4 md:grid-cols-[minmax(0,1fr)_230px]">`
  (the Spot chart + level-ladder row).
- `app/prices/page.tsx:12` —
  `<div className="grid gap-4 xl:grid-cols-2">` (the price-chart grid).

## Why it matters

This is a latent pattern, not a live bug — see Evidence below for why it
doesn't trip today. But it is exactly the shape that caused the `/` bug, and
the reason it didn't fire on `/` either until Task 16's sweep actually
rendered the page at a phone viewport and measured it. Any future change
that makes either grid's children carry more intrinsic width — a longer
symbol label, a wider chart legend, an added column, more `PriceChart`
children reflowing differently — can silently reintroduce the same
horizontal-scroll bug, and nothing today would catch it except a human
eyeballing a phone-width screenshot, because both routes already pass the
mobile viewport sweep at their current content.

## Evidence

Checked directly against the running dev server (`test/fixtures/root`
fixture, 390×844 viewport, Playwright/Chromium 151.0.7442.5), fresh as of
2026-09-02 (not restated from the Task 16 report, though it corroborates
that report's numbers):

- `/prices`: `getComputedStyle` on the grid at `app/prices/page.tsx:12` —
  `gridTemplateColumns: "358px"` (exactly the 358px content-box width, i.e.
  the 390px viewport minus the page's 16px side padding × 2 minus the
  hairline scrollbar/border budget already accounted for elsewhere), 12
  `PriceChart` children in the fixture. `document.documentElement`:
  `scrollWidth: 390` == `clientWidth: 390`. No overflow.
- `/` (Overview, Technical panel): `getComputedStyle` on the grid at
  `components/technical-panel.tsx:97` — `gridTemplateColumns: "324px"`
  (the panel's own narrower content box), same page-level
  `scrollWidth: 390` == `clientWidth: 390`. No overflow.

Why they don't overflow while `app/page.tsx`'s grid did: both grids'
children are chart components (`PriceChart`'s `ResponsiveContainer`,
`SpotChart`) that don't contribute a large min-content size the way the
Overview's column content (text-heavy panels) did — `ResponsiveContainer`
and similar chart wrappers report a small/zero intrinsic min-content width,
so the `auto` implicit column has nothing large to grow to. That is a
property of the *current* children, not of the grid rule itself — nothing
stops a future child (a wide badge row, an unwrapped table, a long ticker
symbol) from changing that.

The existing `e2e/mobile.spec.ts` nine-route sweep (`" fits the viewport"`,
one test per route including `/` and `/prices`) already runs
`document.documentElement.scrollWidth <= clientWidth + 1` at 390px on every
route — including both files above — and was demonstrated non-vacuous on
Task 16 (reverting the `/` fix made it fail with the exact 115px figure). It
is already the mechanism that would catch a regression here; it simply isn't
tripped by the current fixture content on these two routes.

## Fix

Two options, not mutually exclusive:

1. **Preemptive hardening** — add the missing base `grid-cols-1` (or
   equivalent, e.g. `grid-cols-1 md:grid-cols-[minmax(0,1fr)_230px]` /
   `grid-cols-1 xl:grid-cols-2`) to both grids now, mirroring the `/` fix
   exactly. Cheap, and removes the trap before content ever grows into it.
2. **Fixture hardening** — extend `test/fixtures/root`'s technical/price
   data so at least one fixture row/child is wide enough to reproduce the
   min-content blowout (e.g. a long symbol string, a wide indicator value),
   which would turn the existing nine-route sweep into an active regression
   guard for this exact pattern rather than a sweep that happens to pass.

Option 1 alone closes the immediate risk; option 2 is what would have caught
the original `/` bug earlier and prevents this from recurring a third time
in some other grid nobody has audited yet.

## Done when

- Both grids either carry an explicit base `grid-cols-*` (option 1) or the
  fixture content is grown to a point where the nine-route sweep would fail
  without it (option 2, then option 1 applied to make it pass) — either way,
  `npx playwright test --project=mobile` continues to pass afterward.
- A note in this file (or the resolving commit) states which option was
  taken and why.

## Related

- `.superpowers/sdd/2026-09-01-panel-design-system/task-16-report.md` —
  the report that found and fixed the `/` instance and flagged these two as
  deferred.
- `app/page.tsx:231` — the fixed instance, for the pattern to mirror.
- `e2e/mobile.spec.ts` — the nine-route sweep that already covers both
  routes and would fail if this recurs with sufficiently wide content.
