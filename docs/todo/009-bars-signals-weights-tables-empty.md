---
id: 009
title: bars/signal_states/weight_fits tables are empty; bars backfill 429-blocked
status: done
opened: 2026-08-26
owner: unassigned
closed: 2026-09-06
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

## Resolution

Closed by the 6 Sep 2026 retro after verifying the problem statement is no
longer true. `state/jamasp.db` at 2026-09-06T16:00Z:

- `bars`: 11,742 rows — GC 1d 2020-01-24 → 2026-09-04, 1h 2025-05-28 →
  2026-09-04T23:00Z, 4h → 2026-09-04T20:00Z, 1w → 2026-08-31.
- `signal_states`: 48 rows, latest `atr14@1w` at 2026-09-07T00:00Z.
- `weight_fits`: 88 rows, `fitted_at` 2026-09-05T23:37:55Z;
  `state/weights.json` exists (theme fit n=233).

What shipped between the 26 Aug finding and this check: #28 (`fix(bars)`: a
dead Yahoo leg must not take the whole weights pipeline down) and #30
(`feat(bars)`: fall back to Bitfinex XAUT when Yahoo refuses deep history).

Not resolved here, and deliberately left in **todo-012** (in-progress),
which supersedes this item: why Yahoo 429s the 730d hourly pull, the
oneshot unit's abort chain, and the missing watchdog freshness check on
`bars`/`signal_states`/`weight_fits`. The "loud failure path" this file
asked for is item 3 of 012's Problem section.

