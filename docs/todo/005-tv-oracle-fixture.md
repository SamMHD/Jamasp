---
id: 005
title: tests/fixtures/tv_oracle.json not captured — Yahoo daily endpoint returns 429
status: open
opened: 2026-08-20
owner: unassigned
closed:
---

## Problem

`scripts/capture-tv-oracle.py` (Task 4, `jamasp/indicators.py`) could not
capture `tests/fixtures/tv_oracle.json`. The TradingView scanner leg
succeeded; the Yahoo daily-bars leg returned HTTP 429 on every attempt.
`tests/test_indicators_oracle.py` skips cleanly without the fixture
(`pytest.fixture` calls `pytest.skip(...)` when the file is missing), so this
does not block the rest of the suite — it just means the cross-check against
TradingView's own numbers has never actually run.

## Why it matters

The oracle test is what makes "we compute the same 17 indicators TradingView
serves" a checkable claim rather than a second, unverified implementation. As
long as the fixture is missing, `test_indicators_oracle.py`'s four assertions
(close, RSI14, SMA50/SMA200, ATR14 vs TradingView) are never exercised in CI
or locally, so a real bug in `jamasp/indicators.py` — a wrong smoothing
constant, an off-by-one window — would not be caught by this cross-check
until someone runs the capture script successfully.

## Evidence

Checked 2026-08-20, from this worktree
(`/Users/saman/Rabin/Jamasp/.worktrees/market-maps-learning`), running
`uv run python scripts/capture-tv-oracle.py`:

- TradingView leg (`https://scanner.tradingview.com/symbol?symbol=COMEX%3AGC1!&fields=close,RSI,SMA50,SMA200,ATR&no_404=true`)
  succeeded: HTTP 200, body
  `{"ATR":101.82197623436458,"RSI":68.09441674487196,"SMA200":4515.153500000002,"SMA50":4192.209999999998,"close":4542.9}`.
- Yahoo leg (`https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=5y&interval=1d`,
  the same `DAILY_URL` `jamasp/ingest/bars.py` already uses for backfill)
  returned HTTP 429 "Too Many Requests" — reproduced twice, 15 seconds apart,
  both directly and through `jamasp.net.get_with_fallback` (which retries
  once through `JAMASP_EXTRACT_PROXY` on failure; that env var is unset in
  this environment, so the fallback path was never actually exercised here).
- This matches the controller's note on the Task 4 brief that "Yahoo has
  been returning HTTP 429 to this repo recently."
- No fixture was fabricated. `tests/test_indicators_oracle.py`'s `oracle`
  fixture calls `pytest.skip("run scripts/capture-tv-oracle.py to record the
  fixture")` when `tests/fixtures/tv_oracle.json` is absent, confirmed by
  running `uv run pytest tests/test_indicators_oracle.py -v` — all four
  tests report `SKIPPED`, not `PASSED` or `FAILED`.

## Fix

Re-run the capture script from an environment Yahoo isn't currently
rate-limiting (a different egress IP, or after Yahoo's block window lapses),
or set `JAMASP_EXTRACT_PROXY` to a working egress proxy so
`get_with_fallback`'s retry path has somewhere to go:

```sh
uv run python scripts/capture-tv-oracle.py
```

On success it writes `tests/fixtures/tv_oracle.json` and prints
`wrote tests/fixtures/tv_oracle.json — <N> bars, TV close <number>`; commit
the fixture once captured.

## Done when

`tests/fixtures/tv_oracle.json` exists and is committed, and
`uv run pytest tests/test_indicators_oracle.py -v` reports four `PASSED`
(not `SKIPPED`) — or this is closed `abandoned` with a recorded reason if
the oracle cross-check is judged not worth chasing further.

## Amendment 2026-08-22 — the fixture, once captured, will only cover 5 of the 17 computed fields

Filed while fixing Finding 4 of the market-maps-learning-loop Important-
findings wave
(`.superpowers/sdd/2026-08-20-market-maps-learning-loop/final-fix-report.md`),
which added a golden-vector test for `macd()` and a population-vs-sample-
stdev test for `bollinger()` specifically because this oracle cannot cover
either indicator even once the 429 above is resolved.

`scripts/capture-tv-oracle.py`'s TradingView leg (see Evidence above)
requests exactly five fields: `close,RSI,SMA50,SMA200,ATR`. Once captured,
`tests/test_indicators_oracle.py` cross-checks four indicator columns —
`rsi14`, `sma50`, `sma200`, `atr14` — plus the raw `close` price, against
`jamasp/indicators.py`'s `INDICATOR_KEYS`, which names 17 columns total:

```
close, sma50, sma200, rsi14, atr14, macd, macd_signal, adx, stoch_k,
stoch_d, willr, bb_upper, bb_lower, fib618, fib50, pivot_r1, pivot_s1
```

Twelve columns — `macd`, `macd_signal`, `adx`, `stoch_k`, `stoch_d`, `willr`,
`bb_upper`, `bb_lower`, `fib618`, `fib50`, `pivot_r1`, `pivot_s1` — have
never been cross-checked against TradingView's own numbers by this oracle,
capture script fixed or not. The exact failure mode this oracle exists to
catch — `jamasp/indicators.py`'s module docstring names conflating `ema`
with `_wilder` ("produces curves that look entirely plausible and disagree
with every chart") — sits inside `macd`, one of the twelve uncovered
columns, which is why Finding 4 added a hand-derived golden-vector test
for `macd()` independent of this oracle rather than waiting on it, and did
the same for `bollinger`'s population-vs-sample-stdev choice (also
uncovered here, since `close`/`RSI`/`SMA50`/`SMA200`/`ATR` say nothing about
Bollinger's band width).

TradingView's scanner endpoint is understood to serve `MACD.macd`,
`MACD.signal`, `ADX`, `Stoch.K`, `Stoch.D`, `W.R`, `BB.upper`, `BB.lower`,
and `Pivot.M.Classic.R1`/`S1` as standard field names — **not verified live
in this sitting**, only recalled from TradingView's published field
reference, so treat it as a starting point to check rather than a confirmed
fact. Fibonacci retracement (`fib618`/`fib50`) may have no scanner
equivalent at all, since it depends on a lookback window the scanner has no
concept of; that needs checking too, and may mean those two columns stay
permanently outside this oracle's reach regardless of the 429.

### Fix, widened

When re-running the capture script (see Fix above), also widen `fields=` to
request the twelve currently-missing indicators, confirm which ones
TradingView's scanner actually serves for `COMEX:GC1!`, and extend
`tests/test_indicators_oracle.py` with one assertion per newly-covered
field. Whatever the scanner genuinely cannot serve (Fibonacci retracement is
the likely candidate) should be recorded here as a permanent gap with the
reason, not left as an unexplained hole in the assertion count.

### Done when, widened

In addition to the original Done when above: `tests/test_indicators_oracle.py`
asserts against as many of the 17 `INDICATOR_KEYS` as TradingView's scanner
can actually serve, and any field it cannot serve is named here with why.

## Related

- `.superpowers/sdd/2026-08-20-market-maps-learning-loop/task-4-brief.md` —
  Steps 5-8 (capture script, oracle test, tolerance judgement).
- `.superpowers/sdd/2026-08-20-market-maps-learning-loop/final-fix-report.md`
  — Finding 4, which added `tests/test_indicators.py`'s
  `test_macd_matches_hand_derived_ema12_ema26_ema9` and
  `test_bollinger_uses_population_not_sample_stdev` specifically to cover
  what this oracle, even fixed, still would not have.
- `scripts/capture-tv-oracle.py`, `tests/test_indicators_oracle.py`.
- `jamasp/ingest/bars.py` — `DAILY_URL`, shared with the daily `bars`
  backfill, so this same 429 would also affect that path if it recurs.
