# Market maps — the learning loop

**Date:** 2026-08-20
**Status:** design approved in conversation; no code written
**Extends** `2026-08-18-market-maps-design.md` §3, and **corrects one of its decisions** (see "A correction to the earlier spec").

## The ask

Both market maps size their tiles by a weight that is supposed to be *learned* from what gold actually did. Today every weight is 1.0. This plan builds the machinery that fits them — and, because the same machinery is what a technical signal needs in order to have a state at all, the technical map alongside it.

## What is already true

Facts established by measurement or by reading the repo, which this design builds on rather than re-deriving:

- **Scored news is accumulating.** 138 rows in the first 29 hours (~115/day), across five of the six themes; `etf_flows` is still empty. The fit consumes **hourly** rows, so that is 29 training rows — nowhere near fittable. Two to three weeks is the honest floor for the fundamental half.
- **Yahoo serves deep history.** Measured 2026-08-18: `range=730d&interval=1h` returns **17,395** GC=F bars (2024-03-26 → 2026-08-18), resampling to ~4,349 4h bars. `range=5y&interval=1d` covers the daily set.
- **TradingView serves no history at all** — one call returns one instant. So `docs/todo/003` (weekly/4h fields returning null for `COMEX:GC1!`) **does not block this plan**: the fit needs historical states, which are computed from bars whatever the live source turns out to be. That todo governs the technical map's *live* values only.
- **The panel already has the map component.** `MarketMap` takes `items`, `width`, `height`, `range`, `coverage`; `layoutMap` groups by a string key and lays out two levels; `tone()` maps a signed intensity onto the five-step ramp. The technical map is the same component with different inputs.
- **The palette's all-pairs CVD measurement** is recorded in the earlier spec: two pairs fail (2.8 protan, 3.1 deutan), so the 45° hatch covers **both** bearish tones. That applies here unchanged.
- **`jamasp` has no numpy.** Its seven dependencies are pure-Python or small.

## Decisions

| | |
|---|---|
| Scope | shared machinery, then **both** the fit and the technical map |
| Bar storage | a new `bars` table — `prices` is scalar and ATR needs highs and lows |
| Linear algebra | **add numpy** |
| Fit structure | **two fits**, not one — see the correction below |
| Technical tile area | the learned multiplier alone |
| Technical tile colour | the signal's state, straight onto the existing ramp |
| Live weekly/4h values | out of scope; `docs/todo/003` stands |

### Rejected alternatives

- **Four `GC_OPEN` / `GC_HIGH` / … symbols in `prices`** rather than a `bars` table — quadruples the rows and makes every read a self-join.
- **Hand-rolled linear algebra** to avoid the numpy dependency — about 60 lines and 5–15s per fit, which is acceptable; rejected because numerics a reader must *audit* are worse than numerics a reader *recognises*.
- **Close-only bars** — ATR needs high and low, and ATR is both a signal and the divisor that normalises the fit's target.
- **Deferring the technical map to a later plan** — its blocking dependency is the signal-classification layer, which this plan builds anyway.

## A correction to the earlier spec

`2026-08-18-market-maps-design.md` §3 specifies **one** fit over all features. That was written assuming both halves of the feature set would accumulate together. They do not: technical signals backfill five years, while scored news starts 2026-08-19.

In a single joint fit over all history, every theme column is zero for ~99.9% of rows. The theme coefficients would then be estimated from tens of rows embedded in thousands, while the reported `n` per theme said *thousands* — making the confidence treatment overstate certainty exactly where it is least deserved. Restricting the joint fit to the scored window instead throws away the five-year backfill, inverting the asymmetry the design was built around.

**This spec supersedes that decision with two fits.**

## 1 · Bars, indicators, signals

### `bars`

```sql
CREATE TABLE IF NOT EXISTS bars (
    symbol    TEXT NOT NULL,
    timeframe TEXT NOT NULL,   -- '1d' | '4h' | '1w'
    ts        TEXT NOT NULL,   -- bar OPEN time, UTC
    open      REAL NOT NULL,
    high      REAL NOT NULL,
    low       REAL NOT NULL,
    close     REAL NOT NULL,
    PRIMARY KEY (symbol, timeframe, ts)
);
```

`ts` is the bar's **open** time. Stated explicitly because a close-stamped bar shifts every indicator by one period, and that error is invisible until someone compares against a chart.

### `jamasp bars backfill`

Yahoo's chart API — the endpoint `gold_spot` already polls. Daily from `range=5y&interval=1d`; 4h resampled from `range=730d&interval=1h`; weekly resampled from daily. Idempotent on the primary key, so a re-run fills gaps rather than duplicating, and a partial fetch is safe to retry.

Resampling is ours, not Yahoo's: a 4h bar's open is the first hour's open, its high and low the extremes across the group, its close the last hour's close. Groups align to UTC midnight so bar boundaries are stable across runs.

### `jamasp/indicators.py`

Pure. Given a bar series, computes: RSI14, SMA50, SMA200, MACD and signal, ADX, Stochastic %K and %D, Williams %R, Bollinger upper/lower, ATR14, Fibonacci 0.618 and 0.5 retracements, pivot R1/S1. Twelve of the fourteen signals; **GVZ and CFTC net spec are external series** that already land in `prices` and are read from there.

### `jamasp/signals.py`

Pure. Maps each raw value to a state in **[−1, +1] where positive is bullish for gold** — e.g. RSI → `clamp((50 − rsi) / 20)`, so 30 reads +1 and 70 reads −1.

This layer is ours regardless of where raw values come from: TradingView serves values, not calls, and its aggregate `Recommend.*` gauges stay excluded because neither map produces an aggregate verdict.

**TradingView is the oracle for the daily set.** For any indicator TV serves, a test asserts `|ours − TV| < tol` at the same instant. That is what makes computing them ourselves a checkable claim rather than a second implementation nobody can compare.

## 2 · The two fits

One training row per hour. Target throughout: **GC's forward return over horizon `H`, divided by ATR14**, so it is comparable across volatility regimes. `H` defaults to 24h and is a retro-owned hyperparameter.

### Fit A — technical weights

- **Rows:** all bar history.
- **Features:** the 42 signal states, forward-filled from their bar cadence.
- **Yields:** the technical multipliers, fitted from day one.

### Fit B — theme weights

- **Rows:** from the first scored item onward.
- **Features:** 6 theme exposures **plus the 42 signal states as controls**.
- **Yields:** the theme multipliers only. The signal coefficients are discarded — they exist so a news effect is not credited with a move the tape was already making.

**Theme exposure at hour `t`** is the summed `tier_weight` of items published in that hour; the target is the return over `(t, t+H]`. Each item therefore contributes to exactly one row.

**A known statistical caveat, recorded rather than hidden:** with `H` = 24h, consecutive rows have overlapping target windows, which autocorrelates residuals. This inflates apparent significance without biasing the coefficients. It is why the confidence display reports standard errors and sample counts rather than p-values, and why the thresholds are calibrated by eye against observed spread rather than by a significance test.

### From coefficients to multipliers

Ridge shrinks coefficients toward **zero**, not toward one. The multiplier is `β / β̄`, normalised so the mean is 1.0 — so shrinking coefficients toward zero shrinks the *multipliers* toward each other, i.e. toward 1.0. The behaviour the design wants falls out of standard ridge, but only when the normalisation is written this way; the naive reading ("ridge shrinks toward 1.0") is false.

Multipliers clamp to **[0.25, 3.0]**. A negative fit clamps to the floor **and raises a flag the retro must address** — a negative coefficient means items scored *bullish* were followed by gold going *down*, which is evidence the **direction scoring** is wrong for that theme, not that the theme should shrink. Taking `abs()` would bury the single most useful thing the regression can report.

### Storage and cadence

| | owner | holds |
|---|---|---|
| `config/weights.yaml` | retro — *intent* | taxonomy, signal list, `tier_weight`, `H`, ridge α, confidence thresholds, **pins** with reason and expiry |
| `state/weights.json` | daily fit — *measurement* | fitted β, n, standard error, `fitted_at`, per fit |
| `weight_fits` table | daily fit | full trajectory, so a multiplier's drift is inspectable |

Effective weight = active pin if present, else fitted, then clamped. Expired pins lapse automatically at fit time.

`jamasp weights fit` is a deterministic CLI command on its own daily timer — no agent run, no token cost, the same class of job as the flash pipeline. It is a **full refit** from history each time, not an incremental nudge: idempotent, reproducible, no drift.

## 3 · The technical map

The same `MarketMap` component with different inputs. Signals group into five families — trend, momentum, levels, volatility, positioning — exactly as stories group into themes, so `layoutMap` needs no change.

Two things differ, and both are deliberate:

**Area is the learned multiplier alone.** There is no tier for a signal. This makes the Bourse analogy exact: there, market cap is stable and sets the *shape* while the day's move sets the *colour*. Here the multiplier — how much a signal has historically mattered — sets the shape, and the current state sets the colour. A consequence worth stating: the technical map's shape barely changes between refreshes. That is correct, not stale.

**Colour is the signal's state**, already a single number in [−1, +1], mapped onto the same five-step ramp. Same palette, same mandatory bearish hatch on both bearish tones.

**The confidence treatment finally does real work here.** Fitted weights render solid; weights still at 1.0 for want of a sample render with a dashed outline. On day one the technical map is largely solid, since it fits from five years of backfill.

**Before the first fit every technical multiplier is 1.0, so every tile is the same size** and the map reads as a uniform grid. That is honest rather than broken — but it looks odd, which is why the rollout runs the backfill and Fit A *before* the component goes live.

## Testing

- `indicators.py` — golden vectors per indicator, **plus the TradingView-oracle test** for the daily set.
- `signals.py` — each classifier at its extremes and its neutral point; the sign convention pinned (positive = bullish for gold) by a test that would fail if any classifier were inverted.
- Resampling — a known hourly series resamples to known 4h and weekly bars; boundary alignment pinned at UTC midnight.
- Backfill — an idempotent re-run writes no duplicates; a partial fetch resumes.
- The fits — a synthetic series with known coefficients recovers them; the negative clamp fires **and flags**; pins override; expired pins lapse; the `β/β̄` normalisation produces a mean of 1.0.
- Fit B specifically — a synthetic case where a theme's apparent effect is entirely explained by a concurrent technical state must yield a theme coefficient near zero. That is the whole point of the controls, and the test that proves they work.
- The technical map — renders from signal states; the hatch covers both bearish tones; unfitted weights render dashed.

## Rollout

1. `bars` table and `jamasp bars backfill`; verify bar counts against the measured figures.
2. `indicators.py`, with the TradingView-oracle test.
3. `signals.py`.
4. Fit A, `state/weights.json`, `weight_fits`, the daily timer.
5. Fit B on the same machinery.
6. The technical map — **after** step 4, so it never renders as a uniform grid.

## Out of scope

- **Live weekly/4h values from TradingView** — `docs/todo/003` stands. The technical map's live values for those timeframes come from the same computed path as the fit until that question is settled.
- **The `item_scores` coverage ceiling.** The fit sees whatever the triage classified; items that arrived outside `flash.max_age_hours` are unscored and simply absent.
- **Any aggregate buy/sell verdict**, on either map. `config/sources.yaml:326` stands.
- **Multi-horizon weight sets.** One `H`, retro-tunable.
