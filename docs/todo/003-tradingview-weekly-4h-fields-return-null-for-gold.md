---
id: 003
title: TradingView weekly/4h technical fields return null for COMEX:GC1!
status: open
opened: 2026-08-19
owner: unassigned
closed:
---

## Problem

`jamasp/ingest/prices.py`'s `tv_gc_technicals` source requests 51 fields from
TradingView's keyless scanner endpoint — 17 base technical fields, each at
daily, weekly (`|1W`) and 4h (`|240`) resolution. All `|1W` and `|240` fields
come back explicit JSON `null` for `COMEX:GC1!`. Only the 17 daily-resolution
series actually land in `prices`; ~34 of ~51 configured series accumulate
nothing.

`parse_tradingview_scanner_json` skips null fields by design (see its comment
in `jamasp/ingest/prices.py`), so this is a silent partial feed, not a parser
bug — nothing raises, nothing logs to `source_errors`.

## Why it matters

The market-map design's technical half is meant to carry multi-timeframe
context (`GC_RSI14_1W`, `GC_RSI14_4H`, and the weekly/4h counterparts of the
other 16 base fields). With this gap, those series never accumulate any
history at all — not degraded, absent. Anything downstream that assumes a
`_1W`/`_4H` suffix exists once `tv_gc_technicals` has run for a while (a
retro, a dashboard, Plan 2's technical fit) will find nothing there and could
misread that as a bug in its own code rather than a known upstream gap,
unless this is on record.

## Evidence

Checked 2026-08-19, live against the production endpoint and syntax:

- `config/sources.yaml:332-337` (comment on `tv_gc_technicals`, added in
  550eee7): "Verified live 2026-08-19: the scanner responds with all 51
  requested keys, but every `|1W` and `|240` field comes back JSON null for
  COMEX:GC1! on this endpoint — only the 17 daily-resolution series ... land
  in `prices`."
- **Control:** the identical endpoint and field syntax, substituting
  `NASDAQ:AAPL` for `COMEX:GC1!`, returned real (non-null) values for the
  `|1W` and `|240` fields. This isolates the cause to the gold futures
  symbol itself, not the endpoint, the `_TV_TIMEFRAMES` suffix syntax, or our
  request construction.
- `jamasp/ingest/prices.py`: `_TV_TIMEFRAMES = {"": "", "|1W": "_1W", "|240":
  "_4H"}` and `parse_tradingview_scanner_json` skip `None` values rather than
  raising — confirmed this is deliberate ("Fields can be null when the
  market is closed mid-roll; skip those rather than store garbage"), and
  distinct from the symbol-level null-for-everything behaviour found here.
- `docs/superpowers/specs/2026-08-18-market-maps-design.md`'s "Backfill"
  section: a spike measured Yahoo serving GC=F at `range=730d&interval=1h` →
  17,395 hourly bars (first 2024-03-26, last 2026-08-18), resampling to
  ≈4,349 4h bars — well past the ~750-bar threshold a fit needs. Shallower
  Yahoo windows (`60d&1h` → 1,429 bars, `1mo&1h` → 619 bars) also came back
  live, so the Yahoo endpoint itself is healthy at every depth tried.

Two resolution paths were identified during that spike; neither has been
chosen:

1. **Compute weekly/4h locally from Yahoo bars**, the same way
   `jamasp/indicators.py` already computes the 14 base signals from OHLC
   history for backfill purposes — reuses existing code, and the bar counts
   above show there's enough history.
2. **Try a different TradingView gold symbol.** `COMEX:GC1!` may simply not
   carry computed weekly/4h fields on this scanner endpoint; a different
   gold futures or spot symbol might.

This is **deferred to Plan 2, not a defect in Plan 1**: the scoring
substrate this plan built does not read `tv_gc_technicals` at all. Plan 2's
technical map and fit are what will need the weekly/4h series.

## Fix

Pick one of the two paths above (or a third, if research turns one up) when
Plan 2 starts. Path 1 is the more promising lead: `jamasp/indicators.py`
already exists and is already the backfill code path, so using it live for
4h/weekly too would mean one formula, not two, and TV would stay usable as
the daily-resolution live source plus the CI drift oracle described in the
spec's Backfill section.

## Done when

`prices` accumulates real (non-null) `GC_*_1W` and `GC_*_4H` values on an
ongoing basis, via whichever path Plan 2 picks — or this is closed
`abandoned` with a recorded reason if Plan 2 decides multi-timeframe
technicals aren't worth the cost.

## Related

- `docs/superpowers/specs/2026-08-18-market-maps-design.md` — "Backfill"
  section, source of the Yahoo bar-count measurements.
- `docs/superpowers/plans/2026-08-18-market-maps-scoring-substrate.md`
- `config/sources.yaml:322-344` — the `tv_gc_technicals` source and its
  verified-live comment.
- `jamasp/ingest/prices.py` — `_TV_TIMEFRAMES`, `TV_FIELD_SUFFIXES`,
  `parse_tradingview_scanner_json`.
- `550eee7` — widened the TV field set to 17×3 and recorded the null finding
  in the source comment; `52744f5` — the field-drift guard that followed it.
