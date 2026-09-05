---
id: 015
title: Nothing re-checks the XAUT/gold ratio at fetch time, so a depeg would flow into the fits silently
status: open
opened: 2026-09-06
owner: unassigned
closed:
---

## Problem

Since `bb1ae64` (PR #30) every `bars` row is served by **Bitfinex XAUT/USD**,
because Yahoo refuses deep history from this host. XAUT is accepted as a gold
proxy on the strength of a **one-time, offline** validation recorded in a
comment block — mean ratio to GC=F of 0.98524, sd 0.00250, return correlation
0.9951 over 31 overlapping sessions.

Nothing re-checks that relationship when bars are actually fetched. A depeg, a
venue outage returning stale or garbage candles, or a silent change to
Bitfinex's candle schema would flow straight into `signal_states` and the ridge
fits with no alarm raised.

## Why it matters

The safety argument for the substitution is that every consumer of `bars` is
scale-invariant, so a **constant** multiplicative offset cancels. That argument
is sound and was verified (no reader treats a bar close as a price). It does
not cover a **drifting or broken** offset, which is exactly what a depeg is.

The desk's technical signals — 38 fitted columns, and the flags the maps
render — would keep being computed and published from corrupt inputs, looking
entirely healthy. The watchdog added in `ec4bab6` checks `bars`,
`signal_states` and `weight_fits` for **freshness only**. Fresh, plausible-looking,
wrong data passes every check currently in place.

This is a single-venue, single-issuer dependency: one exchange (Bitfinex) and
one tokenised product (Tether Gold). Worth noting that
`state/watchlist.yaml`'s own `metals-financialization` theme tracks Tether as
the largest private gold holder — the desk's technicals now depend on the
instrument it is analysing.

## Evidence

Checked 2026-09-06, on `main` at `5da4b3e`.

- `jamasp/ingest/bars.py:156-181` records the validation as a comment: `XAUT/GC
  ratio mean 0.98524 sd 0.00250 max deviation 1.89%`, corr 0.9951, 31
  overlapping sessions. It is documentation of a past measurement, not a check.
- Grepping `jamasp/ingest/bars.py` for `ratio|sanity|deviat|validate|compare`
  returns only those comment lines. The guards that do exist are
  `comex_sessions_only` (`bars.py:218`) and source-change eviction in
  `store_bars` — both structural, neither about value plausibility.
- The live run at 2026-09-05T21:33:35Z wrote **11,742 bars, all four timeframes
  sourced `bitfinex`** (`1h=7618 4h=2052 1d=1726 1w=346`), and the unit printed
  `WARNING bars GC: 1d,1h,1w,4h served by the bitfinex fallback, not yahoo GC=F`.
  So this is the live state, not a hypothetical.
- `jamasp/watchdog.py:160-190` asserts freshness of `bars`, `signal_states` and
  `weight_fits` against `MAX(ts)`. No assertion about values.
- **Negative results, so nobody re-probes them:** Yahoo deep history is refused
  from this host — 429 on `range=730d`, `range=2y`, `range=5y&interval=1d`, on
  `period1`/`period2` epoch paging, and on `/v1/test/getcrumb` itself (so the
  crumb workaround cannot be bootstrapped). Only `range=1d&interval=1h`
  is served. Stooq, Barchart, Dukascopy, investing.com, MarketWatch, WSJ, CNBC,
  Nasdaq and TradingEconomics are blocked or no longer carry gold, retried
  through WARP. Falling back to Yahoo on a bad XAUT response is therefore **not**
  currently an option.

## Fix

Add a plausibility check at backfill time, before storing:

- Compare the newest daily bar close against the `prices` GC=F reading for the
  same session. `prices` is independently sourced (the 15-minute `gold_spot`
  poll on `range=1d&interval=1h`, which still works) so it is a genuine second
  opinion, not the same feed twice.
- Reject or refuse to store, loudly, when the observed ratio departs from the
  recorded band by more than a stated tolerance. The measured envelope is mean
  0.98524, sd 0.00250, max observed deviation 1.89% — pick a threshold with
  headroom over normal basis variation but well inside a depeg.
- Record the observed ratio per run so drift is visible over time rather than
  only catchable at the moment it breaks.
- Consider promoting Kraken PAXG/USD (ratio 0.98681, corr 0.9957, 720 daily
  candles — already evaluated in `012`) from rejected-alternative to
  cross-check, so two independent tokenised feeds must agree.

## Done when

A backfill that receives a depegged or garbage XAUT series **fails loudly and
stores nothing**, proven by a test that feeds such a series and asserts the
rows are not written and the failure is reported — plus the observed ratio is
recorded per run so a slow drift is visible before it becomes a break.

Legitimately abandonable if Yahoo deep history (or another COMEX-derived
source) is restored and `bars` no longer depends on a tokenised proxy — in that
case close it with that as the resolution.

## Related

- `docs/todo/012-weights-unit-dies-on-the-yahoo-730d-hourly-pull.md` — the
  investigation that led to the substitution; carries the full provider
  comparison table.
- PR #30 / `bb1ae64` — the fallback itself. PR #28 / `ec4bab6` — the
  partial-success exit policy and the freshness watchdog.
