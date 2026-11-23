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

## Recurrence log

- **Scan 2026-11-21 09:00Z — count mismatch without a race.** Listed 15
  at 09:00:06Z and again 15 at 09:00:24Z (re-list immediately before the
  mark, no new ids); mark at 09:00:25Z reported **20**. All five extras
  have `fetched_at = 08:31:29Z` — 29 minutes *before* the listing: four
  actionforex "EUR/xxx Weekly Outlook" rows and a second mehr_en copy of
  the CITEX photo item (the listed row carried it under `also`). So the
  listing hides rows on its own (cluster duplicates, and apparently
  FX-cross technical outlooks), which settles the unverified fourth row
  above and means "marked N > listed" is **not** a clean race signal —
  option 3 should report rows *fetched after the listing*, not the raw
  difference. None of the five was gold-relevant.
- **Scan 2026-11-21 11:00Z — same pattern, again no race.** Listed 16 at
  11:00:06Z; mark at 11:00:27Z reported **23**. All seven extras are
  actionforex FX-pair "Weekly Outlook/Report" rows with `fetched_at`
  09:01:31Z / 09:31:35Z — 90+ minutes before the listing, so hidden by
  the listing, not late arrivals. None gold-relevant.
- **Scan 2026-11-21 13:00Z — same pattern, cluster-duplicate kind.** Listed
  15 at 13:00:05Z; mark at 13:00:16Z reported **16**. The extra is a
  mehr_en re-headline ("…recent two wars") of a row already read at
  11:00Z, same `cluster_id`, `fetched_at` 12:45:57Z — 14 minutes before
  the listing, so hidden as a duplicate of an already-read cluster head
  (no `also` to show it under). Not a race; not gold-relevant.
- **Scan 2026-11-21 17:00Z — same pattern, first content-bearing hidden
  row.** Listed 18 at 17:00:07Z; mark at 17:00:25Z reported **20**. Both
  extras were fetched before the listing (16:16:26Z, 16:45:46Z) — not a
  race. One is a northern_miner re-headline of the Angola / De Beers row
  (same `cluster_id`, head read 03:35Z; not gold-relevant). The other is
  Gulf News "Middle East war: 8 things UAE residents need to know
  tonight, November 21" (`1113b3e6020910aa`), clustered
  (`c73a6ed9bffffbb3`) with the **20 Nov** edition "6 key updates … this
  evening, November 20" and hidden as a duplicate of that already-read
  head. That is a false cluster: a dated daily digest whose body is new
  every day. Its body carried the day's Gulf items (UKMTO: two tanker
  incidents near Khasab on Saturday; CENTCOM's denial of the F-16 claim;
  an Iranian navy mine claim). None met the scan's alert test, but this
  is the first hidden row that was gold-relevant, and the scan read it
  only because of the manual count check. For the fix: besides reporting
  hidden rows, either the clusterer should not merge serial digests
  across dates (date token in the headline differs, `published_at` ~24h
  apart), or the listing should show an unread row whose cluster head is
  already read.
- **Scan 2026-11-23 11:00Z — largest gap so far, and the first true race.**
  Listed 35 at 11:00:08Z; `--mark-read` at 11:00:17Z reported **"marked
  58 items read"**. Of the 23 extra rows, ~19 carry `published_at`
  10:23Z–10:58Z and were not in the listing at all: an ingest pass landed
  inside the nine seconds between the two commands (the scan and ingest
  timers both fire on the hour). The rest are cluster duplicates (UK /
  eurozone flash PMI siblings, the MarketWatch re-headline). Read after
  the fact from the `items` table by `read_at`; none met the alert test
  (Ackman on a Fed-hike recession, Nvidia / Huang rehiring, Saxo COT, ECB
  DLT collateral). The brief will not see them either. For the fix: this
  is the case the title describes — `--mark-read` should take the
  listing's cut-off (max `fetched_at` or an explicit `--until`) rather
  than marking everything unread at call time.

- **Recurrence — scan 2026-11-23 13:00.** Listed 27 at 13:00:06Z;
  `--mark-read` at 13:00:18Z reported **"marked 33 items read"**. The six
  extra rows are actionforex pair outlooks (EUR/USD, USD/JPY, GBP/USD,
  USD/CHF, USD/CAD, GBP/JPY; `published_at` 11:01Z–11:48Z) that were not
  in the listing. Read after the fact from `items` by `read_at`; none met
  the alert test. Same on-the-hour collision of the scan and ingest
  timers as at 11:00.

- **Recurrence — scan 2026-11-23 17:00.** Listed 24 at 17:00:07Z;
  `--mark-read` at 17:00:23Z reported **"marked 31 items read"**. Not a
  race this time (all seven extras were fetched 15:15Z–16:01Z): every one
  is an unread row hidden behind a cluster head already read at 11:00Z,
  13:00Z or 15:03Z — four Nvidia / Huang re-headlines, the investing.com
  gold and oil wraps, and the **US flash services PMI print post
  (forexlive, 54.7 vs 55.7), which was clustered under the France /
  eurozone flash PMI head read at 11:00Z**. That last one is the
  mis-cluster variant: a scan-marker print hidden from the listing by a
  different country's print. Read after the fact from `items` by
  `read_at`; none met the alert test (the 15:00Z alert already covered
  the move and the PMI).

- **Recurrence — scan 2026-11-23 19:00.** Listed 39 at 19:00:09Z;
  `--mark-read` at 19:00:56Z reported **"marked 45 items read"**. Both
  variants in one run. Four extras are the on-the-hour race (fetched
  19:00:31–32Z, after the listing: two MarketWatch items, and mining.com's
  AngloGold / Sitka and Springpole pieces). Two are cluster-hidden unread
  rows: a gcaptain Costa Concordia item and the **investing.com oil wrap
  "Oil drops more than 3% on increased Middle East flows, Libyan pipeline
  restart" (17:30Z)** — the one row in the delta that bears on a live
  stance clause (Monday's Brent settle vs 92.10), and it was not in the
  listing. All six were read from `items` *before* marking this time (a
  count check between the listing and `--mark-read`); none met the alert
  test. The Tue brief will not get the oil wrap from `inbox`; it reads the
  Brent settle directly, but the "increased Middle East flows" reason
  reaches it only if it sweeps `items` by keyword.
