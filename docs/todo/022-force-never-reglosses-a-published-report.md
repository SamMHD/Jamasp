---
id: 022
title: jamasp translate --force never re-glosses a report that already has a sidecar
status: open
opened: 2026-09-13
owner: unassigned
closed:
---

## Problem

`new_reports(reports_dir, since_iso)` offers only reports that have no
`.fa.md` beside them — that is spec decision 18 ("new reports only") working
as designed for the ordinary pass. But `--force` does not widen the set, so a
published report's Persian sidecar is written exactly once and can never be
regenerated through the CLI.

Every other surface honours `--force`: rows, events, stance sections, the
playbook, watchlist entries and prediction lines all retranslate. Reports
alone are frozen at whatever the translator produced the first time.

## Why it matters

`--force` exists as the remedy for a glossary edit or a bad model run. The
spec says so: "the escape hatch for a glossary change or a bad model run."
`config/glossary.fa.yaml` is shared with the flash pipeline precisely so the
panel and the news channel cannot drift apart on terminology — but a glossary
correction propagates to every surface except the published brief archive,
which is the one surface a reader is most likely to go back and re-read.

The only way to regenerate one today is to delete its `.fa.md` by hand, which
is exactly the sort of manual state surgery the CLI-only write discipline
exists to avoid.

This is pre-existing rather than a regression — `44208b5` fixed the separate
bug where `--force` stopped at the per-run document ceiling, and this
limitation is pinned in a test docstring there — but the two together are why
an operator's mental model of `--force` ("re-gloss everything") does not match
what it does.

## What to do

Decide whether the desk wants `--force` to reach the report archive. If yes,
have the docs pass select reports differently under force: every report at or
after `translate.reports_since`, not only those lacking a sidecar. Note that
this makes a forced run's cost scale with the archive, which is the reason
`--force` is already exempt from the per-run ceiling — worth measuring on the
host before turning it on.

If no, say so in the spec next to decision 18 and in the `--force` help text,
so the limit is a stated choice rather than a surprise.
