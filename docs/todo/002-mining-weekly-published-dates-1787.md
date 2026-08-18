---
id: 002
title: mining_weekly published_at parses to 1785–1787 for every item
status: open
opened: 2026-08-18
owner: unassigned
closed:
---

## Problem

Every `mining_weekly` item in `state/jamasp.db` has a `published_at` in the
1780s. The real publication date is visible in each article URL slug (e.g.
`...-2026-08-18`), so the source's date field is being misparsed on ingest,
not missing upstream.

## Why it matters

`published_at` drives inbox ordering, the flash pipeline's 24-hour dedup
window, and any freshness logic. A 240-years-stale timestamp means a
top-tier gold item from Mining Weekly (e.g. the 18 Aug "Gold shows early
signs of reclaiming safe-haven appeal" piece) can be sorted to the bottom of
the delta or silently excluded from the news channel while looking
successfully ingested. The source is one of the few gold-topic feeds, so the
distortion lands exactly where coverage matters.

## Evidence

Observed 2026-08-18 ~13:05Z, same sitting:

- `uv run jamasp inbox` returned two `mining_weekly` items with
  `"t": "1787-02-25T00:00:00Z"` and `"t": "1787-02-14T00:00:00Z"`; both URLs
  end in `-2026-08-18`.
- Read-only query on `state/jamasp.db`:
  `SELECT source, COUNT(*), MIN(published_at), MAX(published_at) FROM items
  WHERE published_at < '2000' GROUP BY source` →
  `('mining_weekly', 126, '1785-07-01T00:00:00Z', '1787-02-25T00:00:00Z')`.
- `SELECT COUNT(*) ... WHERE source='mining_weekly'` → 126 total, i.e.
  **every** row from this source is affected; no other source has pre-2000
  dates.
- Bad dates increase monotonically with `fetched_at` (1785-07 → 1787-02 over
  the archive), which smells like an ordinal/serial date or epoch-offset
  being interpreted as a date, not random garbage.
- Not yet checked: the raw feed payload for `mining_weekly` (what the date
  field actually contains) — the parser in the ingest source config is the
  place to look first.

## Fix

Inspect the raw `mining_weekly` feed entry to see what date format it
serves; fix the parser (or fall back to extracting `YYYY-MM-DD` from the URL
slug, which is reliably present). Then repair the 126 existing rows —
either rewrite `published_at` from the URL slug or accept the archive as-is
and fix forward only (decide at fix time; dedup only looks back 24h so
forward-only is probably fine).

## Done when

New `mining_weekly` items land with `published_at` matching the URL slug
date, and `SELECT COUNT(*) FROM items WHERE source='mining_weekly' AND
published_at < '2000' AND fetched_at > '<fix date>'` stays 0 across a few
ingest cycles.
