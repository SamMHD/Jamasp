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

## Related

- `.superpowers/sdd/2026-08-20-market-maps-learning-loop/task-4-brief.md` —
  Steps 5-8 (capture script, oracle test, tolerance judgement).
- `scripts/capture-tv-oracle.py`, `tests/test_indicators_oracle.py`.
- `jamasp/ingest/bars.py` — `DAILY_URL`, shared with the daily `bars`
  backfill, so this same 429 would also affect that path if it recurs.
