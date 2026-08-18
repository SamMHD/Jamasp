---
id: 002
title: The same article reposts to the news channel when its headline is rewritten
status: open
opened: 2026-08-18
owner: unassigned
closed:
---

## Problem

`rss.item_id()` hashes `(source, url, headline)`, so a publisher that rewrites a
live article's headline mints a **new item** for a URL already posted. The flash
pass sees an unprocessed item, the triage model sees a headline it has no
24-hour match for, and the same article goes to the channel again.

Investing.com's "Live levels" articles rewrite their headline through the day
with the current price and indicator reading, so one URL produced six channel
messages across five days.

## Why it matters

23 of 544 flashes to 2026-08-17 were repeats of a URL already posted — **4% of
channel traffic**, delivered as apparently-new stories. It is not the volume that
hurts so much as the credibility: the desk sees "Gold hits RSI 77 at $4,415"
and "Gold double top at $4,509" as two calls, when they are one article edited
in place.

Neither existing defence catches it:

- **`dup_of`** only sees the last 24 hours of posted flashes, so a repeat on
  day 2+ has nothing to match against.
- **The clusterer** compares headlines at `similarity_threshold: 80`, and these
  rewrites differ far more than that — the six items landed in six distinct
  `cluster_id`s.

## Evidence

Queried on the host, 2026-08-17 database.

One URL, six messages, six item ids, six headlines, six clusters:

```
https://www.investing.com/news/commodities-news/gold-hits-rsi-77-at-4415-overbought-peak

08-10T07:17 msg=44   Gold hits RSI 77 at $4,415 overbought peak: Live levels
08-11T07:36 msg=126  Gold surges 5% above 50-MA, exhaustion risk rises: Live levels
08-12T07:17 msg=221  Gold overbought at $4,462 with MACD fading: Live levels
08-13T07:35 msg=307  Gold flashes bearish reversal warning at $4,434: Live levels
08-14T07:32 msg=392  Gold double top at $4,509 with break brewing: Live levels
08-14T19:32 msg=436  Gold consolidates near $4,432 as MACD turns bearish: Live levels
```

Scale across the whole table: **15 URLs posted more than once, 23 redundant
messages out of 544 (4%)**. The worst offenders are all investing.com
"Live levels" and similar rolling technical pieces.

**Tiering may already have solved most of this.** Every repeat above is a
scheduled technical-analysis piece, which the tier definitions added in #10 and
tuned in #12 score at 1 ("scheduled technical-analysis columns") — i.e. dropped
before it reaches the channel at all. That is the reason this is filed rather
than fixed: the fix should be sized against what survives tiering, not against
the pre-tiering number.

Negatives checked in the same sitting, so they are not re-probed:

- `treasury_press` — `source_errors` carries a 404 for
  `https://home.treasury.gov/rss.xml` at 2026-08-17T19:46. Re-probed from the
  host: **HTTP 200, 39662 bytes**. The 404 was transient; the feed is not dead
  and needs no change.
- `national_business` — 588 items, 514 skipped, but **13 did post**, and its
  `published_at` range is 2021-07-08 .. 2026-08-17. The high mean age-at-fetch
  is the feed carrying archive content, which `skipped_born_old` handles
  correctly. Not a defect.
- `mining_weekly` — was a real defect, a different one, and is **fixed**: its
  feed published a raw Unix epoch in `<published>`, which feedparser read as
  year 1786. See `ccacaee`.

## Fix

Decide first whether anything is left to fix after a week of live tier data
(see **Done when**). If it is, the candidates, cheapest first:

1. **Suppress at triage.** Pass the URL alongside the headline in
   `build_decide_prompt`, and extend the `POSTED` block to carry URLs, so the
   model can mark a rewrite as `dup_of` the original. Cheapest, but still bound
   by the 24-hour `posted_flashes()` window.
2. **Widen the dedup window for URL matches only.** In `_run_pass`, before
   classification, check the candidate's URL against `flashes.url` over a
   longer horizon (say 7 days) and record it as `dup` outright. Deterministic,
   no model involvement, and it is a URL equality test rather than a judgement.
   Note this would fold genuine follow-ups that reuse a URL, which is why the
   horizon needs a number someone is willing to defend.
3. **Drop the headline from `item_id()`.** Correct in principle — the article is
   the URL — but it changes item identity across the whole database and would
   need a migration plan for existing rows. Out of proportion unless 1 and 2
   both fail.

Option 2 is the likely answer, with the horizon in `config/settings.yaml` under
`flash:` rather than as a constant.

## Done when

Either:

- a week of tier data (from 2026-08-18) shows the surviving repeat rate at or
  below ~1% of channel messages, and this is closed **abandoned** with that
  measurement recorded — tiering having solved it is a legitimate outcome; or
- a fix ships and a query over `flashes` for the following week shows no URL
  posted more than once, excluding deliberate follow-ups.

The measurement to re-run, against `state/jamasp.db`:

```sql
SELECT COUNT(*) urls, SUM(n) - COUNT(*) extra
FROM (SELECT url, COUNT(*) n FROM flashes
      WHERE created_at >= '<week start>' GROUP BY url HAVING n > 1);
```

## Related

- `docs/superpowers/specs/2026-08-17-flash-tiering-design.md` — tiering, which
  named the narrative-dedup gap as explicitly out of scope.
- `docs/superpowers/specs/2026-08-17-flash-tiering-brief.md` — the measurement
  that first counted the "same story, many angles" bucket.
- PR #12 — tier calibration; demoted driver-free gold price-action recaps to
  tier 3 and retail pricing to tier 1.
- `ccacaee` — the `mining_weekly` epoch-date fix found in the same investigation.
