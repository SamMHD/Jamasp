---
id: 203
title: The fed_press RSS source has 404'd on feeds/press_all.xml since 13 Oct (last item 16 Oct) and nothing beyond the inbox header flags a silent Fed feed
status: open
opened: 2026-10-26
owner: unassigned
closed:
---

## What happened

`config/sources.yaml` line ~179 points `fed_press` at
`https://www.federalreserve.gov/feeds/press_all.xml`. `source_errors` shows
`Client error '404 Not Found'` for that URL on 13 Oct (×2), 16 Oct, 17 Oct
(×2) and 25 Oct 23:16Z; the last `fed_press` item in `items` is
2026-10-16T15:00Z. The only surface for this is the `jamasp inbox` header
line ("source 'fed_press' had errors in the last 24h and produced no new
items"), which a brief sees once a day and a scan never does.

Found by the Mon 26 Oct brief, two days before the 28 Oct FOMC. Not blocking
that run: deepdive #75 extracts the Board statement URL directly
(`/newsevents/pressreleases/monetary20261028a.htm`), per rule 24. But every
press release outside a deepdive — implementation notes, Board votes,
speech announcements — now reaches the pipeline only via relays.

## Suggested fix (a dev decides)

1. Verify whether the Board moved or renamed the feed (check
   `https://www.federalreserve.gov/feeds/` for the current list; the
   per-category feeds such as `press_monetary.xml` may still resolve) and
   repoint `fed_press`, or split it into monetary + other.
2. Alert on a source that errors ≥N consecutive polls or goes ≥48h without
   an item outside a known quiet window — the same class of gap as the
   calendar-feed outages (todo-001) that four retros re-raised before a
   file existed for them.
