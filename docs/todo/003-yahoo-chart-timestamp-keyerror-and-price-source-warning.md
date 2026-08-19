---
id: 003
title: yahoo_chart_json 'timestamp' KeyError + inbox coverage-gap warning misfires for price sources
status: open
opened: 2026-08-19
owner: unassigned
closed:
---

## Problem

Two related defects around price sources:

1. The `yahoo_chart_json` parser intermittently raises a bare `'timestamp'`
   KeyError (Yahoo returns a chart object with no timestamp array, most
   plausibly during closed-market/quiet windows).
2. `jamasp inbox` prints a "source X had errors in the last 24h and produced
   no new items — possible coverage gap" warning for `price_api` sources.
   Price sources write to the `prices` table and *never* produce items, so a
   single transient error makes the warning fire even while price data is
   landing normally — a standing false positive.

## Why it matters

The 18–19 Aug stance carried "gold_spot + gold_vol erroring with no items 24h
— possible coverage gap" across two runs, and the 18 Aug brief spent
attention on a data outage that did not exist: GC rows were landing every
15 minutes throughout. A warning that cries wolf trains the analyst runs to
ignore it — the day a price source genuinely dies, the alert will be
indistinguishable from the noise.

## Evidence

Verified 2026-08-19 ~03:35Z in the same sitting:

- `source_errors` table: `('gold_vol', '2026-08-18T13:45:15Z', "'timestamp'")`,
  `('gold_spot', '2026-08-18T04:01:08Z', "'timestamp'")`, and a gold_spot
  burst 2026-08-16T21:16–22:00Z (4 rows, same message). The error text is a
  bare KeyError repr — no context about what Yahoo actually returned.
- `prices` table simultaneously current: GC rows at 03:20:08Z, 03:05:27Z,
  02:51:08Z on 2026-08-19 (15-min cadence, no gap); ^GVZ last row 2026-08-18
  (plausible for an index outside CBOE hours).
- `jamasp inbox` header 2026-08-19T03:30:16Z still warned for both sources.
- Config: both sources are `type: price_api`, `parser: yahoo_chart_json`,
  hitting `query1.finance.yahoo.com/v8/finance/chart/...` (config/sources.yaml).

## Fix

- Parser: treat a chart response with a missing/empty `timestamp` array as
  "no new data" (return zero rows) rather than raising; log the raw response
  shape at debug level so a real schema change is still visible.
- Inbox warning: exclude `price_api` sources from the items-based
  coverage-gap check, or replace it for them with a prices-table staleness
  check (e.g. warn when no price row for the source's symbol in N×interval).

## Done when

A deliberately empty chart response produces no `source_errors` row, and
`jamasp inbox` no longer warns about a price source whose latest price row is
within its expected staleness window (checkable by re-running inbox after the
next quiet-hours cycle). Warning still fires if a price source's data is
genuinely stale.

## Related

- state/stance.md "Sourcing health" 2026-08-18/19; 2026-08-18 brief.
- config/sources.yaml comments dated 2026-07-31 (Yahoo chart API adoption).
