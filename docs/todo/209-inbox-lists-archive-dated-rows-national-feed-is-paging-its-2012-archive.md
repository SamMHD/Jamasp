---
id: 209
title: "`jamasp inbox` has no age floor — the `national_business` feed is paging through its 2012–13 archive and those rows fill the listing"
status: open
opened: 2026-11-24
owner: unassigned
closed:
---

## What happened

Scan 2026-11-24 09:00Z. `jamasp inbox` reported **158 unread** and printed
120 lines (the `cap` in `jamasp/inbox.py:51`); **83 of the 120 were
`national_business` rows dated 2012** ("Resolutions - two met, one missed -
made 2012 memorable", "Gold sanctions on Iran could slow Turkish deficit
reduction", …). Only 37 lines were today's news. The listing was 46 KB, a
bit over half of it archive.

The feed started serving its archive this morning and is walking forward
through it one ingest at a time:

| `fetched_at` | rows | `published_at` range |
|---|---|---|
| 2026-11-24T08:01:05Z | 45 | 2012-11-01 → 2012-11-30 |
| 2026-11-24T08:31:05Z | 76 | 2012-12-07 → 2012-12-31 |
| 2026-11-24T09:00:16Z | 56 | 2012-12-23 → 2013-01-01 |

177 rows in an hour, all `published_at` at `T00:00:00Z`. (One earlier
isolated case: a 2019-dated row fetched 2026-10-23.) Not checked: whether the
feed URL in `config/sources.yaml` changed behaviour upstream or the parser is
now following a pagination/archive link.

## What is already safe

The flash pipeline is not affected: all 177 rows are in `flash_items` as
`skipped_born_old` (`jamasp/flash.py:199–222`), none scored, none sent to the
news channel. Checked at 09:02Z.

## Why it matters

`inbox.render` is `… WHERE read_at IS NULL … ORDER BY published_at DESC` with
a 120-row cap and no age test. Today's rows sort first, so the archive does
not push real news out — but it fills every listing up to the cap:

- every scan pays ~25 KB of 2012 headlines (scans are meant to be a few
  thousand tokens);
- if the flood continues at this rate the Wed 25 Nov brief's listing is
  padded to 120 rows whenever its real delta is smaller, on a run that
  already fights the 900 s cap (todo 199);
- the header count ("158 unread") stops meaning anything, which weakens the
  count check that todo 207's workaround depends on;
- not verified: whether the 10-minute `translate` pass is spending codex
  calls on Persian renderings of these headlines for the panel.

## What should change

1. Give `inbox` the same born-old test flash has — a row whose
   `published_at` is more than N days before its `fetched_at` is not listed
   (or is marked read at ingest). Reuse the flash threshold rather than
   inventing a second one.
2. Find out why `national_business` is returning archive pages and fix or
   pin the feed; consider a per-source ingest floor so such rows never land.
3. Test: insert a row with `published_at` years before `fetched_at`, assert
   `render` omits it and the header count excludes it.

## Workaround used

None needed for the decision — the 37 real rows were read normally and the
unlisted rows were read by headline from `items` before marking. The archive
rows were marked read with the rest.
