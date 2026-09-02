---
id: 010
title: Figure, DataList and StatChips' interfaces don't yet cover what the remaining page migrations need
status: open
opened: 2026-09-02
owner: unassigned
closed:
---

## Problem

The design-system plan's four shared primitives (`Panel`, `Figure`,
`DataList`, `StatChips`) shipped this phase; migrating the remaining pages
onto them is explicitly future work (see
`docs/superpowers/specs/2026-09-01-panel-redesign-design.md`'s per-page
plan, e.g. "`/schedule`. `StatCard` becomes `Figure` inside a `Panel`" and
"`/inbox` ... `DataList`"). Reviewing those two primitives plus `StatChips`
against what the pages they're slated for actually need surfaces three
concrete interface gaps that will block a straight swap-in:

1. **`Figure` (`components/ui/figure.tsx:18-27`)** takes `value: number |
   null`, but `app/schedule/page.tsx:31` currently renders exactly the
   value `Figure` is meant to replace as a *string*:
   `<StatCard label="Runs today (Dubai)" value={`${runsToday}/${cap}`}
   tone={runsToday >= cap ? "warn" : undefined} />`. `Figure` cannot accept
   `"7/12"` — it calls `.toLocaleString()` on `value`, which requires a
   `number`. `Figure` also has no `tone` prop at all, though `StatCard`
   (`components/stat-card.tsx:4-7`, the component it replaces) has one
   (`ok`/`warn`/`bad`, used by exactly this `/schedule` call site), and no
   unit/prefix slot for a value like a `$` price or a `bps` delta that
   other pages' stat tiles carry.

2. **`DataList` (`components/ui/data-list.tsx:6-13`)**'s `Column<T>` has no
   per-row modifier and no per-column alignment. `/inbox`'s current table
   (`components/inbox-table.tsx:132`, `{!rep.read_at && <Badge>unread</Badge>}`)
   needs a "gold left rule + unread label" row treatment per the redesign
   spec's `/inbox` entry — that is a per-*row* style hook `DataList` has no
   way to express, since `Column` only describes per-column rendering.
   Numeric columns across the tables slated for `DataList` (schedule's
   duration/exit-code, prices) also have no alignment control — `cell()`
   can right-align its own contents with a wrapper `<span>`, but the
   *header* cell (`TableHead`) and the stacked-view label
   (`data-list.tsx:47`) have no matching per-column alignment, so a numeric
   column reads inconsistently between the table and stacked renderings.

3. **`StatChips` (`components/shell/stat-chips.tsx:37-39`)** keys each
   chip with `key={chip.label}`: `<Link key={chip.label} ...>` /
   `<span key={chip.label} ...>`. That's safe today because `StatChips` has
   no call site yet (`grep -rl StatChips app/ components/` finds only the
   component's own file). But the migration this primitive exists for is
   `StatusStrip`'s four run-type dots (`components/status-strip.tsx`'s
   `RUN_TYPES.map` block) becoming `StatChips` — four *structurally
   identical* chips distinguished only by which run type they report on.
   If that migration builds each chip's `label` the way `StatusStrip`
   currently labels them (the bare run-type word doubling as both display
   text and, implicitly, identity), a shared or reused label string across
   two chips silently collides on `key`, and React drops or misrenders one
   of them with no error.

## Why it matters

None of these are bugs in what shipped this phase — `Figure`, `DataList`
and `StatChips` are only broken relative to migrations that haven't
happened yet. But the spec commits specific pages to specific primitives
(`/schedule` → `Figure`, `/inbox` → `DataList`, and `StatChips` exists
for no other purpose than the run-type-chip migration), and starting any
of those migrations without addressing the gap above means either a broken
build (`Figure` given a string), a silently missing style requirement
(`DataList`'s per-row modifier), or a silent rendering bug (`StatChips`'
key collision) discovered mid-migration instead of planned for.

## Evidence

Checked directly against source, 2026-09-02:

- `components/ui/figure.tsx:18-27` — `value: number | null` in the props
  type; `value.toLocaleString(...)` at line 34 (throws/is a type error on a
  string).
- `app/schedule/page.tsx:31-32` — the exact string-valued, toned call site:
  `value={`${runsToday}/${cap}`}` with `tone={runsToday >= cap ? "warn" :
  undefined}`.
- `components/stat-card.tsx:4` — `TONES = { ok, warn, bad }`, the tone
  vocabulary `Figure` doesn't have.
- `components/ui/data-list.tsx:6-13` — `Column<T>` type: `key`, `header`,
  `cell`, `hideOnNarrow`. No per-row field, no per-column `align`.
- `components/inbox-table.tsx:132` — the current unread-row treatment
  (`<Badge>unread</Badge>` only; no left-rule) that the spec's `/inbox`
  entry says should become a per-row "gold left rule".
- `components/shell/stat-chips.tsx:37-39` — `key={chip.label}` on both the
  `Link` and `span` branches.
- `grep -rl StatChips app/ components/` → only `components/shell/stat-chips.tsx`
  itself; confirmed no live call site exists yet, so the collision risk is
  latent, not currently firing.

## Fix

Not prescribing the final shape — that's a design decision for whoever
picks up each page migration — but at minimum:

1. `Figure`: accept `value: number | string | null` (or a `formatted?:
   string` escape hatch alongside the numeric path), add a `tone?:
   keyof typeof TONES` matching `StatCard`'s vocabulary, and a
   `unit`/`prefix` slot.
2. `DataList`: add an optional per-row `rowClassName?: (row: T) => string`
   (or similar) to `DataList`'s own props for row-level treatments, and an
   `align?: "start" | "end"` on `Column` applied to both the table `<TableHead>`/
   `<TableCell>` pairing and the stacked `<dt>`/`<dd>` pairing so the two
   renderings agree.
3. `StatChips`: key by an explicit `id` (or the chip's index plus label) as
   the caller-neutral default, or require the caller to pass a stable
   `id` field separate from the display `label`.

Add a short comment at each of the three call/definition sites above
(`components/ui/figure.tsx`, `components/ui/data-list.tsx`,
`components/shell/stat-chips.tsx`) pointing at this todo, so whoever starts
a page migration finds it before hitting the gap mid-change.

## Done when

- `/schedule`'s stat tile migrates to `Figure` without a type error and
  without losing the cap-reached `warn` tone.
- `/inbox`'s table migrates to `DataList` with the unread row's gold left
  rule expressed through `DataList`'s own API, not a one-off wrapper around
  it.
- `StatusStrip`'s four run-type dots migrate to `StatChips` (or `StatChips`
  gains a test proving four same-shaped chips render distinctly) with no
  key collision.

## Related

- `docs/superpowers/specs/2026-09-01-panel-redesign-design.md` — the
  per-page migration plan naming `Figure`/`DataList` as the target for
  `/schedule`/`/inbox`.
- `.superpowers/sdd/2026-09-01-panel-design-system/final-fix-report.md` —
  the review pass that filed this item.
