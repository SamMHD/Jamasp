---
id: 009
title: bars/signal_states/weight_fits tables are empty; bars backfill 429-blocked
status: open
opened: 2026-08-26
owner: unassigned
closed:
---

## Problem

Found during the 26 Aug PCE deepdive (run of wakeup #38): all three tables of
the bars/signals/weights subsystem hold zero rows —

- `bars`: 0 rows (`SELECT COUNT(*)` = 0)
- `signal_states`: 0 rows
- `weight_fits`: 0 rows

`uv run jamasp bars backfill` fails with `httpx.HTTPStatusError: 429 Too Many
Requests` from `query1.finance.yahoo.com/v8/finance/chart/GC=F?range=730d&interval=1h`.
Whether the tables were ever populated on this host or were wiped at some
point is unknown; either way the daily weights-refit timer and `signals
refresh` are running against an empty substrate, presumably no-op'ing or
erroring silently (no desk alert observed).

Note the 730-day 1h range in the failing request — a large first-fetch that
may itself be what trips Yahoo's rate limit on a cold table.

## Why it matters

- CLAUDE.md describes `bars` as "the substrate for indicators and the ridge
  fit" and lists a daily weights-refit timer among the eight. A silently
  empty substrate means the learned market-map multipliers (`weights fit`)
  cannot exist, so anything consuming them is running on defaults or stale
  state without saying so.
- Analysis runs are currently unaffected: `jamasp price` technicals (RSI,
  BB, MACD, stoch, ADX) come from the `prices` series, which is current.
  But that makes the gap invisible — nothing fails loudly.

## Shape of a fix (decision not mine)

- Backoff/retry or a smaller initial range (chunked backfill) against
  Yahoo's 429, or an alternate OHLC source.
- A loud failure path: if `bars` is empty when `signals refresh` or
  `weights fit` runs, that should reach the desk (alerting skill), not
  no-op.
- Verify what the panel and any signal consumers show when these tables are
  empty.
