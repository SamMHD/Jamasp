---
id: 183
title: gold_spot (GC=F, range=1d) returns no bars through an open Globex session on a US holiday — no GC print since 4 Sep 20:59Z
status: open
opened: 2026-09-07
owner: unassigned
closed:
---

## Problem

`gold_spot` (Yahoo chart API, `GC=F?range=1d&interval=1h`, 15-min cadence)
has raised the bare `'timestamp'` KeyError on **every** poll from
2026-09-06 20:15Z through at least 2026-09-07 03:31Z — 30+ consecutive
errors — while CME Globex was open and gold was trading (the bitfinex
fallback in `bars` shows the session: 22:00Z open 4420.4, 01:00Z low
4391.9). The `prices` table has **no `GC` row after 2026-09-04T20:59:58Z**.
Last Sunday (30 Aug) the same source produced GC rows from 22:06Z onward,
every 15 minutes, so this is not the ordinary closed-market blip that
todo-003 describes.

Likely cause (unverified): Yahoo keys `range=1d` to the exchange's trade
date, and CME's trade date for the Sunday 22:00Z open is **Monday 7 Sep =
US Labor Day**, which Yahoo marks as a holiday for CME products — so the
"current day" range is empty even though Globex trades. `dxy_intraday`
(ICE `DX-Y.NYB`, not on holiday) errored 20:30–22:00Z Sunday and then
resumed at 22:06Z, which fits: the KeyError is Yahoo answering with no
timestamp array for a session it does not recognise.

## Why it matters

- `jamasp price` served **GC 4477.2 @2026-09-04** to the 7 Sep brief, a
  session and a half stale, with no warning that the row was old.
- Four open level claims are scored on GC prints — `a1fc647f` (no print
  <4425 through the Monday close), `85f08a28` (≥4500 in session one),
  `a3ad30b1` (no close >4554) and `746afbe2` (no close <4300) — and the
  only tape in the DB is the bitfinex XAUT proxy, which trades ~45 below
  GC on Friday's basis (4431 vs 4477). The 7 Sep brief scored `58b7daab`
  on the proxy because the margin (0.3% vs a 1.5% band) made basis
  irrelevant; `a1fc647f` (margin ~15 pts on the proxy) cannot be scored
  that way.
- `predictions due --open` `window_high`/`window_low` are computed from
  `prices.GC`, so every claim opened 5–7 Sep shows `n/a` and the rule-13
  "run the check, never narrate" discipline has nothing to run.

## Evidence

- `source_errors`: `gold_spot` `'timestamp'` at 20:15, 20:30, 20:45,
  21:00, 21:16, 21:30, 21:46, 22:00, 22:16, 22:31, 22:45, 23:01, 23:15,
  23:30, 23:45Z (6 Sep) and 00:01 … 03:31Z (7 Sep) without a gap.
- `prices` GC cadence: 30 Aug 7 rows (from 22:06Z), 31 Aug 87, 1 Sep 89,
  2 Sep 82, 3 Sep 87, 4 Sep 80 (last 20:59:58Z), 5–7 Sep **0**.
- `bars` GC 1h (bitfinex): 2026-09-06T22:00Z 4420.4/4431.2/4414.8/4428.6
  … 2026-09-07T03:00Z 4410.0 — the session exists, the quote feed missed it.
- `ingest` 7 Sep 03:30Z: `WARN gold_spot: 'timestamp'` … `0 price
  snapshots`.

## Fix

1. Pull `range=5d` (or `2d`) and keep only the newest bar, so a holiday
   trade date still yields the live session; the parser already dedupes
   on `ts`.
2. Make `yahoo_chart_json` log what Yahoo returned when `timestamp` is
   missing (the `meta` block carries `regularMarketTime`/`tradingPeriods`),
   so todo-003's "closed-market blip" and this "open-market miss" are
   distinguishable in `source_errors`.
3. `jamasp price` prints the row age next to GC when it exceeds one
   session (e.g. `GC 4477.2 @2026-09-04 (STALE 31h)`), and
   `predictions due --open` says which symbol backs `window_high/low` and
   when it last updated.

## Related

- todo-003 (the same KeyError as a false-positive warning while data
  lands) — this item is the case where data does **not** land.
- todo-012 (`bars` served by the bitfinex fallback, not Yahoo GC=F) —
  the fallback that made the session visible at all; its basis to GC is
  todo-015's open question.
- todo-182 (`matured` fires before window close) — the 7 Sep brief scored
  `58b7daab` at its event, not its `matured` flag.
