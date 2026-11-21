---
id: 207
title: "`jamasp inbox --mark-read` marks every unread row, including items ingested after the run's `inbox` listing — they are consumed without any run having seen them"
status: open
opened: 2026-11-21
owner: unassigned
closed:
---

## What happened

Scan 2026-11-21 07:00Z. `jamasp inbox` listed **12 unread** at 07:00:08Z.
The close-out `jamasp inbox --mark-read` at 07:00:30Z reported
**"marked 16 items read"**. Three of the extra four rows have
`fetched_at = 2026-11-21T07:00:27Z` — the 15-minute ingest landed between
the listing and the mark:

- gulf_news — "Middle East war: 5 things UAE residents need to know today (Nov 21, 2026)"
- gulf_news — "Passenger plane makes emergency landing in Philippines…"
- national_business — "Anthropic's post-IPO slide shows hype not enough to ease AI investor fears"

(The fourth, national_business "Oil prices post third weekly decline…",
was fetched 05:00:19Z and not shown in the listing — probably a deduped
cluster member; not verified.)

None was urgent this time; the run found them only because the count
mismatch (12 listed vs 16 marked) prompted a manual query of `items` by
`read_at`.

## Why it matters

`mark_read` (`jamasp/inbox.py:85`) is
`UPDATE items SET read_at = ? WHERE read_at IS NULL` — no upper bound. The
scan timer and the ingest timer both fire on the hour, so every scan slot
races an ingest: anything that lands during the run (seconds for a silent
scan, up to 15 minutes for a brief or deepdive) is marked read unseen. With
todo-184 (silent scans leave no trace for the brief) this is a second way a
headline can vanish before any run reads it — and on a live-market slot the
unseen item could be the wire flash the scan exists to catch.

## What should change

Bound the mark to what was listed. Options, cheapest first:

1. `inbox` prints a high-water mark (max `fetched_at` or rowid) in its
   header and `--mark-read --upto <mark>` only marks rows at or below it.
2. `inbox` records the listed high-water mark in the DB (per run) and
   `--mark-read` uses the last recorded one by default.
3. At minimum, have `--mark-read` print how many of the marked rows were
   fetched after the last listing, so the run knows to look.

Add a test: insert an item after the listing, assert it stays unread.

## Workaround used

When "marked N" exceeds the listed count, query
`select published_at, fetched_at, source, headline from items where read_at like '<mark ts>%'`
and read the rows the listing did not show before exiting.
