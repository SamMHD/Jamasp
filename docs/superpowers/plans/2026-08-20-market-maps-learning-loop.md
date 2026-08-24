# Market Maps — The Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fit both market maps' importance multipliers from what gold actually did, and ship the technical map that the same machinery makes possible.

**Architecture:** Yahoo OHLC bars land in a new `bars` table; pure `indicators.py` computes fourteen indicator families from them and pure `signals.py` maps each to a state in [−1, +1] where positive is bullish for gold. `features.py` assembles one training row per hour — signal states forward-filled from completed bars only, theme exposures from `item_scores` — and `fit.py` runs two ridge regressions over it: Fit A (technicals, all bar history) and Fit B (themes, with the technical states as controls). Coefficients become clamped multipliers in `state/weights.json`; the panel reads them to size tiles on both maps.

**Tech Stack:** Python 3.12, click, httpx, PyYAML, **numpy** (new), SQLite; Next.js 16.2.12 App Router, TypeScript, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-20-market-maps-learning-loop-design.md`

**Also read:** `docs/superpowers/specs/2026-08-18-market-maps-design.md` §1 and §4 for the palette and the fundamental map's encoding. Note that its §3 single-fit decision is **superseded** by the spec above.

---

## Corrections this plan makes to the spec

The spec was approved before these three arithmetic/structural details were worked through. Each is a deliberate, recorded change — implement the plan, not the superseded prose.

**1. `bars` also stores a `'1h'` timeframe.** The spec's schema comment lists `'1d' | '4h' | '1w'`, but the same spec says "one training row per hour" and targets a forward return at hourly resolution. With no hourly close stored there is no `close(t)` to compute that return from. Yahoo already returns 17,395 hourly bars in the call we make anyway, so we store them instead of discarding them after resampling. Consequence, stated honestly: Fit A's hourly target history is **2 years** (Yahoo's `range=730d` ceiling for `interval=1h`), not five. The five-year daily set still serves indicator warm-up, which is what SMA200 needs.

**2. There are 38 signal states, not 42.** The spec derives 42 as 14 signals × 3 timeframes. Two of the fourteen — GVZ and CFTC net spec — are external series with no timeframe dimension: GVZ is an hourly Yahoo series and net spec is a weekly CFTC print, so a "4h net spec" is not a thing that exists. The real count is 12 computed signals × 3 timeframes + 2 external = **38**. Nothing structural depends on the number; `config/weights.yaml` declares each signal's own timeframe list and the column count is derived, so nobody hand-counts it again.

**3. Ridge's compression toward 1.0 is weaker than the spec's phrasing implies.** With `m = β / β̄`, a *uniform* shrinkage factor cancels: multiply every β by k and m is unchanged. The compression the spec wants is real but comes from ridge's *differential* shrinkage (low-variance directions shrink more), not from the scale factor. So α is a genuine retro lever, just a gentler one than "turn α up to shrink multipliers toward 1.0" suggests. The implementation is exactly what the spec specifies; only the expectation is corrected.

---

## Global Constraints

Every task's requirements implicitly include these. Values are copied verbatim from the spec.

- **`bars.ts` is the bar's OPEN time, UTC**, formatted `%Y-%m-%dT%H:%M:%SZ`. A close-stamped bar shifts every indicator by one period and the error is invisible until someone compares against a chart.
- **Signal states live in [−1, +1] where positive is bullish for gold.** RSI 30 reads +1, RSI 70 reads −1.
- **No lookahead, ever.** A signal's state at hour `t` may only use bars that had already *closed* by `t` — `open_ts + duration <= t`. A bar whose open is at or before `t` but which is still forming is the future.
- **Multipliers clamp to [0.25, 3.0].** A negative coefficient clamps to the floor **and raises a flag**; never `abs()` it. A negative coefficient means items scored bullish were followed by gold falling — evidence the direction scoring is wrong for that theme, which is the single most useful thing the regression can report.
- **`config/weights.yaml`'s `themes:` order is positional and load-bearing.** The fit indexes feature columns by position. Same for `signals:`.
- **`config/weights.yaml` is the retro's file (intent); `state/weights.json` is the daily fit's file (measurement).** The fit never writes YAML.
- **The fit is a full refit from history, deterministic and idempotent** — not an incremental nudge.
- **No aggregate buy/sell verdict on either map.** `config/sources.yaml:326` stands: technicals annotate the macro read, they must not originate calls.
- **The hatch covers BOTH bearish tones** (`bear` and `bear-mid`), on every map. Two ramp pairs fail CVD outright (2.8 protan, 3.1 deutan); hatching only the pole silently reintroduces both failures.
- **The panel reads `state/jamasp.db` read-only and performs every write through the `jamasp` CLI.** Keep it that way.
- **The panel must degrade, never 500.** Missing table, missing `state/weights.json`, empty result — each renders an honest empty/unfitted state.
- Python tests: `uv run pytest`. Panel tests: `npm test` (vitest) **and** `npm run e2e` (Playwright — vitest excludes `e2e/**`, so page-level regressions are invisible to `npm test` alone). Type check: `npx tsc --noEmit`.
- Commit after every task with a message explaining *why*, not only what.

---

## File Structure

**New Python**

| File | Responsibility |
|---|---|
| `jamasp/ingest/bars.py` | Yahoo chart JSON → `Bar` tuples; resampling; `store_bars`; `backfill`. Mirrors `jamasp/ingest/prices.py`'s parse+store shape. |
| `jamasp/indicators.py` | Pure indicator math over a bar series. No I/O, no config. |
| `jamasp/signals.py` | Pure classification of indicator values into [−1, +1]. No I/O, no config. |
| `jamasp/features.py` | Assembles the hourly training matrix from bars, signal states and `item_scores`. |
| `jamasp/fit.py` | Ridge, normalisation, clamping, flags; writes `state/weights.json` and `weight_fits`. |

**Modified Python**

| File | Change |
|---|---|
| `jamasp/db.py` | `bars`, `signal_states`, `weight_fits` tables + indices. |
| `jamasp/config.py` | `tier_weights()`, `signal_specs()`, `signal_columns()`, `fit_config()`, `active_pins()`. |
| `jamasp/cli.py` | `bars backfill`, `signals refresh`, `weights fit`. |
| `config/weights.yaml` | `tier_weight`, `signals`, `fit`, `pins`. |
| `pyproject.toml` | `numpy>=2.0`. |

**New panel**

| File | Responsibility |
|---|---|
| `panel/lib/technicalmap.ts` | Signal tiles: multiplier → area, state → colour, family grouping. Pure. |
| `panel/components/technical-map.tsx` | Server-rendered SVG technical map. |
| `panel/components/map-tiles.tsx` | Tile painting, hatch `<defs>`, legend — shared by both maps. |

**Modified panel**

| File | Change |
|---|---|
| `panel/lib/marketmap.ts` | Generic `layoutGroups`; `toneFromIntensity`; optional per-theme multiplier in `layoutMap`. |
| `panel/lib/db.ts` | `latestSignalStates()`. |
| `panel/lib/files.ts` | `readFittedWeights()`, `loadWeightsConfig()`. |
| `panel/components/market-map.tsx` | Uses the shared tile component; accepts theme multipliers. |
| `panel/app/page.tsx` | Renders the technical map; passes multipliers to the fundamental map. |

**New ops**

| File | Responsibility |
|---|---|
| `ops/systemd/jamasp-weights.service` / `.timer` | Daily backfill → signals refresh → weights fit. |

---

### Task 1: Bars — parsing and resampling

**Files:**
- Create: `jamasp/ingest/bars.py`
- Create: `tests/test_bars.py`
- Modify: `jamasp/db.py` (add the `bars` table to `SCHEMA`)
- Modify: `tests/test_db.py` (assert the new table exists)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class Bar(NamedTuple): ts: str; open: float; high: float; low: float; close: float`
  - `parse_yahoo_bars(text: str) -> list[Bar]`
  - `resample(bars: list[Bar], seconds: int) -> list[Bar]`
  - `resample_weekly(bars: list[Bar]) -> list[Bar]`

**Context you need:** `jamasp/ingest/prices.py` already parses this exact Yahoo payload for its last close (`parse_yahoo_chart_json`). Read it first — the JSON shape is `chart.result[0]` with a `timestamp` array and `indicators.quote[0]` holding parallel `open`/`high`/`low`/`close` arrays. Any of those four can be `null` when a session is thin; a bar missing any leg is not a bar.

- [ ] **Step 1: Add the `bars` table to the schema**

In `jamasp/db.py`, append to the `SCHEMA` string (after the `prices` table, so related storage sits together):

```sql
-- OHLC bars, for the indicators and the ridge fit. `prices` is scalar and
-- cannot hold a high or a low; ATR needs both, and ATR is both a signal and
-- the divisor that normalises the fit's target.
--
-- ts is the bar's OPEN time. Stated here because a close-stamped bar shifts
-- every indicator by one period, and that error stays invisible until
-- someone compares a computed SMA against a chart.
--
-- '1h' is stored as well as the spec's '1d'/'4h'/'1w': the fit's target is a
-- forward return at hourly resolution, so it needs an hourly close to
-- measure from. Yahoo returns the hourly series in the same call we make for
-- the 4h resample, so storing it is free. Yahoo caps interval=1h at
-- range=730d, which is what bounds the hourly history — not this table.
CREATE TABLE IF NOT EXISTS bars (
    symbol    TEXT NOT NULL,
    timeframe TEXT NOT NULL,   -- '1h' | '4h' | '1d' | '1w'
    ts        TEXT NOT NULL,   -- bar OPEN time, UTC
    open      REAL NOT NULL,
    high      REAL NOT NULL,
    low       REAL NOT NULL,
    close     REAL NOT NULL,
    PRIMARY KEY (symbol, timeframe, ts)
);
```

- [ ] **Step 2: Write the failing schema test**

Add to `tests/test_db.py`:

```python
def test_bars_table_exists(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    assert conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='bars'"
    ).fetchone()
    cols = {r[1] for r in conn.execute("PRAGMA table_info(bars)")}
    assert cols == {"symbol", "timeframe", "ts", "open", "high", "low", "close"}


def test_bars_primary_key_is_symbol_timeframe_ts(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    row = ("GC", "1d", "2026-08-01T00:00:00Z", 1.0, 2.0, 0.5, 1.5)
    conn.execute("INSERT INTO bars VALUES (?,?,?,?,?,?,?)", row)
    # Same key, different values: INSERT OR REPLACE must overwrite, not duplicate.
    conn.execute("INSERT OR REPLACE INTO bars VALUES (?,?,?,?,?,?,?)",
                 ("GC", "1d", "2026-08-01T00:00:00Z", 9.0, 9.0, 9.0, 9.0))
    conn.commit()
    rows = conn.execute("SELECT close FROM bars").fetchall()
    assert len(rows) == 1 and rows[0]["close"] == 9.0
```

- [ ] **Step 3: Run the schema tests**

Run: `uv run pytest tests/test_db.py -v -k bars`
Expected: PASS (the schema edit in Step 1 already satisfies them). If either fails, the `SCHEMA` edit is wrong — fix it before continuing.

- [ ] **Step 4: Write the failing parse and resample tests**

Create `tests/test_bars.py`:

```python
import json

import pytest

from jamasp.ingest.bars import Bar, parse_yahoo_bars, resample, resample_weekly


def _payload(timestamps, opens, highs, lows, closes):
    return json.dumps({"chart": {"result": [{
        "meta": {"symbol": "GC=F"},
        "timestamp": timestamps,
        "indicators": {"quote": [{
            "open": opens, "high": highs, "low": lows, "close": closes}]},
    }]}})


def test_parse_yahoo_bars_reads_open_time_and_ohlc():
    # 1767225600 = 2026-01-01T00:00:00Z
    text = _payload([1767225600, 1767229200], [10.0, 11.0], [12.0, 13.0],
                    [9.0, 10.5], [11.0, 12.5])
    bars = parse_yahoo_bars(text)
    assert bars == [
        Bar("2026-01-01T00:00:00Z", 10.0, 12.0, 9.0, 11.0),
        Bar("2026-01-01T01:00:00Z", 11.0, 13.0, 10.5, 12.5),
    ]


def test_parse_yahoo_bars_skips_bars_with_any_null_leg():
    # A bar missing any of O/H/L/C is not a bar: storing it with a fabricated
    # leg would corrupt ATR (which reads high and low) silently.
    text = _payload([1767225600, 1767229200, 1767232800],
                    [10.0, None, 12.0], [12.0, 13.0, 14.0],
                    [9.0, 10.5, 11.0], [11.0, 12.5, 13.5])
    bars = parse_yahoo_bars(text)
    assert [b.ts for b in bars] == ["2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z"]


def test_parse_yahoo_bars_returns_sorted_ascending():
    text = _payload([1767229200, 1767225600], [11.0, 10.0], [13.0, 12.0],
                    [10.5, 9.0], [12.5, 11.0])
    bars = parse_yahoo_bars(text)
    assert [b.ts for b in bars] == ["2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"]


def test_parse_yahoo_bars_raises_on_empty():
    with pytest.raises(ValueError):
        parse_yahoo_bars(_payload([], [], [], [], []))


def _h(hour, o, hi, lo, c):
    return Bar(f"2026-01-01T{hour:02d}:00:00Z", o, hi, lo, c)


def test_resample_4h_aggregates_open_extremes_close():
    # Four hourly bars inside one 4h group (00:00-03:59).
    bars = [_h(0, 10, 12, 9, 11), _h(1, 11, 15, 10, 12),
            _h(2, 12, 13, 7, 8), _h(3, 8, 9, 7.5, 8.5)]
    out = resample(bars, 4 * 3600)
    assert out == [Bar("2026-01-01T00:00:00Z", 10, 15, 7, 8.5)]


def test_resample_4h_groups_align_to_utc_midnight():
    # 03:00 and 04:00 must land in DIFFERENT groups: 14400 divides 86400, so
    # boundaries fall at 00/04/08/12/16/20 UTC and stay stable across runs.
    bars = [_h(3, 1, 1, 1, 1), _h(4, 2, 2, 2, 2)]
    out = resample(bars, 4 * 3600)
    assert [b.ts for b in out] == ["2026-01-01T00:00:00Z", "2026-01-01T04:00:00Z"]


def test_resample_leaves_a_partial_group_as_its_own_bar():
    # A group with fewer members than the interval is still a bar — the most
    # recent one always is, and dropping it would make the latest state a day
    # stale for no gain.
    bars = [_h(0, 10, 12, 9, 11), _h(1, 11, 15, 10, 12), _h(4, 20, 21, 19, 20)]
    out = resample(bars, 4 * 3600)
    assert out == [Bar("2026-01-01T00:00:00Z", 10, 15, 9, 12),
                   Bar("2026-01-01T04:00:00Z", 20, 21, 19, 20)]


def test_resample_weekly_groups_monday_to_sunday():
    # 2026-01-05 is a Monday; 2026-01-11 a Sunday; 2026-01-12 the next Monday.
    daily = [
        Bar("2026-01-05T00:00:00Z", 10, 12, 9, 11),
        Bar("2026-01-08T00:00:00Z", 11, 16, 8, 12),
        Bar("2026-01-11T00:00:00Z", 12, 13, 11, 12.5),
        Bar("2026-01-12T00:00:00Z", 20, 21, 19, 20),
    ]
    out = resample_weekly(daily)
    assert out == [
        Bar("2026-01-05T00:00:00Z", 10, 16, 8, 12.5),
        Bar("2026-01-12T00:00:00Z", 20, 21, 19, 20),
    ]


def test_resample_weekly_stamps_the_monday_even_when_monday_is_missing():
    # A holiday Monday must not shift the week's stamp to Tuesday — that would
    # make the same week land under two different keys across runs.
    daily = [Bar("2026-01-06T00:00:00Z", 10, 12, 9, 11),
             Bar("2026-01-07T00:00:00Z", 11, 13, 10, 12)]
    out = resample_weekly(daily)
    assert [b.ts for b in out] == ["2026-01-05T00:00:00Z"]


def test_resample_of_empty_is_empty():
    assert resample([], 4 * 3600) == []
    assert resample_weekly([]) == []
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `uv run pytest tests/test_bars.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.ingest.bars'`

- [ ] **Step 6: Implement parsing and resampling**

Create `jamasp/ingest/bars.py`:

```python
"""OHLC bars: Yahoo chart JSON parsing, resampling, storage and backfill.

`prices` holds one scalar per (symbol, ts) and cannot express a high or a
low. ATR needs both — and ATR is both a signal in its own right and the
divisor that normalises the fit's target — so bars get their own table
rather than four parallel `GC_OPEN`/`GC_HIGH`/... series that would
quadruple the row count and turn every read into a self-join.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import NamedTuple

TS_FMT = "%Y-%m-%dT%H:%M:%SZ"


class Bar(NamedTuple):
    """One OHLC bar. `ts` is the bar's OPEN time, UTC."""

    ts: str
    open: float
    high: float
    low: float
    close: float


def _fmt(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime(TS_FMT)


def _epoch(ts: str) -> int:
    return int(datetime.strptime(ts, TS_FMT).replace(tzinfo=timezone.utc).timestamp())


def parse_yahoo_bars(text: str) -> list[Bar]:
    """Yahoo chart JSON -> bars, oldest first.

    Yahoo's `timestamp` array holds each bar's OPEN time, which is what this
    table stores. Any bar with a null leg is dropped whole: a fabricated
    high or low would feed ATR and Bollinger directly and the resulting
    error would look like market structure rather than a missing print.
    """
    result = json.loads(text)["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    stamps = result.get("timestamp") or []
    out = [
        Bar(_fmt(ts), float(o), float(h), float(low), float(c))
        for ts, o, h, low, c in zip(
            stamps, quote["open"], quote["high"], quote["low"], quote["close"]
        )
        if None not in (o, h, low, c)
    ]
    if not out:
        raise ValueError("no complete OHLC bars in yahoo chart json")
    # Yahoo returns ascending today, but nothing in the payload promises it and
    # every downstream indicator is order-dependent.
    return sorted(out, key=lambda b: b.ts)


def _fold(group: list[Bar], ts: str) -> Bar:
    return Bar(ts, group[0].open, max(b.high for b in group),
               min(b.low for b in group), group[-1].close)


def resample(bars: list[Bar], seconds: int) -> list[Bar]:
    """Fold `bars` into fixed `seconds`-wide groups aligned to the epoch.

    The resample is ours, not Yahoo's: a group's open is the first member's
    open, its high and low the extremes across the group, its close the last
    member's close.

    Epoch-floor alignment puts 4h boundaries at 00/04/08/12/16/20 UTC,
    because 14400 divides 86400 — so a bar's group is a function of its
    timestamp alone and never of which slice of history a run happened to
    fetch. Do NOT use this for weekly: epoch 0 was a Thursday, so
    epoch-flooring by 604800 would produce Thursday-to-Wednesday weeks.
    Use resample_weekly.
    """
    groups: dict[int, list[Bar]] = {}
    for b in bars:
        groups.setdefault(_epoch(b.ts) // seconds * seconds, []).append(b)
    return [_fold(groups[k], _fmt(k)) for k in sorted(groups)]


def resample_weekly(bars: list[Bar]) -> list[Bar]:
    """Fold daily bars into Monday-stamped ISO weeks.

    The stamp is the week's Monday whether or not a Monday bar exists — a
    holiday Monday must not shift the same week under a second key on the
    next run.

    Monday-UTC is an approximation of the CME gold week, which actually opens
    Sunday 18:00 New York. Weekly states are fit features, never an
    oracle-checked series, so a consistent boundary matters more than the
    exact one; the fit sees the same convention every run.
    """
    groups: dict[str, list[Bar]] = {}
    for b in bars:
        day = datetime.strptime(b.ts, TS_FMT).replace(tzinfo=timezone.utc)
        monday = (day - timedelta(days=day.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0)
        groups.setdefault(monday.strftime(TS_FMT), []).append(b)
    return [_fold(groups[k], k) for k in sorted(groups)]
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `uv run pytest tests/test_bars.py tests/test_db.py -v`
Expected: PASS, all of them.

- [ ] **Step 8: Commit**

Stage `jamasp/ingest/bars.py`, `jamasp/db.py`, `tests/test_bars.py`, `tests/test_db.py` and commit with:

```
feat(bars): OHLC bar table, Yahoo parsing and resampling

prices is scalar and cannot hold a high or a low; ATR needs both, and ATR
is both a signal and the divisor that normalises the fit's target. ts is
the bar's OPEN time — a close-stamped bar shifts every indicator by one
period and the error is invisible until someone checks against a chart.

Weekly resampling groups by ISO Monday rather than epoch-flooring by
604800: epoch 0 was a Thursday, so the arithmetic shortcut would have
produced Thursday-to-Wednesday weeks.
```

---

### Task 2: `jamasp bars backfill`

**Files:**
- Modify: `jamasp/ingest/bars.py` (add `store_bars`, `read_bars`, `backfill`)
- Modify: `jamasp/cli.py` (add the `bars` group and its `backfill` command)
- Modify: `tests/test_bars.py`
- Modify: `tests/test_cli.py`

**Interfaces:**
- Consumes: `Bar`, `parse_yahoo_bars`, `resample`, `resample_weekly` from Task 1.
- Produces:
  - `SYMBOL = "GC"`
  - `store_bars(conn, symbol: str, timeframe: str, bars: list[Bar]) -> int` — rows written; `INSERT OR REPLACE`.
  - `read_bars(conn, symbol: str, timeframe: str) -> list[Bar]` — ascending by ts.
  - `backfill(conn, symbol: str = SYMBOL, fetch=None) -> dict[str, int]` — timeframe → rows written. `fetch` is `Callable[[str], str]` taking a URL and returning the body; defaults to `jamasp.net.get_with_fallback(url).text`.
  - CLI: `jamasp bars backfill [--symbol GC]`

**Context you need:** `jamasp/ingest/prices.py#store_price` is the storage idiom to follow (`conn.execute` + `conn.commit`). `jamasp/cli.py` defines subgroups with `@main.group("wakeup")` + `@wakeup_group.command("add")` and shares `db_opt`/`cfg_opt`/`_common` — read lines 33-60 and 263-300 before writing the command. The two Yahoo URLs are on the same host `gold_spot` already polls (`config/sources.yaml:224`):
- hourly: `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=730d&interval=1h`
- daily: `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=5y&interval=1d`

- [ ] **Step 1: Write the failing storage and backfill tests**

Append to `tests/test_bars.py`:

```python
from jamasp import db
from jamasp.ingest.bars import backfill, read_bars, store_bars


def test_store_and_read_bars_round_trip(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    bars = [Bar("2026-01-02T00:00:00Z", 2, 3, 1, 2.5),
            Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)]
    assert store_bars(conn, "GC", "1d", bars) == 2
    assert read_bars(conn, "GC", "1d") == sorted(bars, key=lambda b: b.ts)


def test_store_bars_is_idempotent(tmp_path):
    # A re-run must fill gaps, not duplicate — a partial fetch has to be safe
    # to retry, and the daily timer re-runs this over overlapping history
    # every day for the rest of the deployment's life.
    conn = db.connect(tmp_path / "j.db")
    bars = [Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)]
    store_bars(conn, "GC", "1d", bars)
    store_bars(conn, "GC", "1d", bars)
    assert len(read_bars(conn, "GC", "1d")) == 1


def test_store_bars_overwrites_a_revised_bar(tmp_path):
    # Yahoo revises the most recent bar as it forms. The stored copy must
    # follow it rather than freeze at the first value seen.
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1d", [Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)])
    store_bars(conn, "GC", "1d", [Bar("2026-01-01T00:00:00Z", 1, 9, 0.5, 8.0)])
    assert read_bars(conn, "GC", "1d") == [Bar("2026-01-01T00:00:00Z", 1, 9, 0.5, 8.0)]


def test_store_bars_keeps_timeframes_separate(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    b = Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)
    store_bars(conn, "GC", "1h", [b])
    store_bars(conn, "GC", "1d", [b])
    assert len(read_bars(conn, "GC", "1h")) == 1
    assert len(read_bars(conn, "GC", "1d")) == 1


def _fake_fetch(hourly_text, daily_text):
    def fetch(url):
        return hourly_text if "interval=1h" in url else daily_text
    return fetch


def test_backfill_writes_all_four_timeframes(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    # 8 hourly bars starting 2026-01-05T00:00Z (a Monday) -> 2 four-hour bars.
    base = 1767571200  # 2026-01-05T00:00:00Z
    hourly = _payload([base + i * 3600 for i in range(8)],
                      [10.0 + i for i in range(8)], [20.0] * 8,
                      [1.0] * 8, [11.0 + i for i in range(8)])
    daily = _payload([base, base + 86400], [10.0, 20.0], [30.0, 40.0],
                     [1.0, 2.0], [15.0, 25.0])
    written = backfill(conn, "GC", fetch=_fake_fetch(hourly, daily))
    assert written == {"1h": 8, "4h": 2, "1d": 2, "1w": 1}
    assert len(read_bars(conn, "GC", "1h")) == 8
    assert len(read_bars(conn, "GC", "4h")) == 2
    assert len(read_bars(conn, "GC", "1d")) == 2
    assert read_bars(conn, "GC", "1w") == [
        Bar("2026-01-05T00:00:00Z", 10.0, 40.0, 1.0, 25.0)]


def test_backfill_is_idempotent(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    base = 1767571200
    hourly = _payload([base + i * 3600 for i in range(8)],
                      [10.0 + i for i in range(8)], [20.0] * 8,
                      [1.0] * 8, [11.0 + i for i in range(8)])
    daily = _payload([base, base + 86400], [10.0, 20.0], [30.0, 40.0],
                     [1.0, 2.0], [15.0, 25.0])
    fetch = _fake_fetch(hourly, daily)
    backfill(conn, "GC", fetch=fetch)
    backfill(conn, "GC", fetch=fetch)
    counts = {tf: len(read_bars(conn, "GC", tf)) for tf in ("1h", "4h", "1d", "1w")}
    assert counts == {"1h": 8, "4h": 2, "1d": 2, "1w": 1}


def test_backfill_keeps_the_hourly_set_when_the_daily_fetch_fails(tmp_path):
    # A partial fetch must leave what it already got. Losing the 730-day
    # hourly pull because the daily call 404'd would make every retry pay for
    # it again.
    conn = db.connect(tmp_path / "j.db")
    base = 1767571200
    hourly = _payload([base + i * 3600 for i in range(4)],
                      [10.0] * 4, [20.0] * 4, [1.0] * 4, [11.0] * 4)

    def fetch(url):
        if "interval=1h" in url:
            return hourly
        raise RuntimeError("daily endpoint down")

    with pytest.raises(RuntimeError):
        backfill(conn, "GC", fetch=fetch)
    assert len(read_bars(conn, "GC", "1h")) == 4
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_bars.py -v -k "store or backfill"`
Expected: FAIL — `ImportError: cannot import name 'store_bars'`

- [ ] **Step 3: Implement storage and backfill**

Append to `jamasp/ingest/bars.py`:

```python
SYMBOL = "GC"

# The same host and endpoint gold_spot already polls (config/sources.yaml:224),
# at the two depths Yahoo actually serves: interval=1h is capped at range=730d,
# interval=1d reaches five years. Measured 2026-08-18: 17,395 hourly bars.
HOURLY_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/GC=F"
    "?range=730d&interval=1h"
)
DAILY_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/GC=F"
    "?range=5y&interval=1d"
)


def store_bars(
    conn: sqlite3.Connection, symbol: str, timeframe: str, bars: list[Bar]
) -> int:
    """Upsert bars. Returns the number of rows written.

    INSERT OR REPLACE rather than OR IGNORE: Yahoo revises the most recent
    bar while it is still forming, and a stored copy frozen at the first
    value seen would quietly disagree with every later fetch.
    """
    conn.executemany(
        "INSERT OR REPLACE INTO bars"
        " (symbol, timeframe, ts, open, high, low, close)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(symbol, timeframe, b.ts, b.open, b.high, b.low, b.close) for b in bars],
    )
    conn.commit()
    return len(bars)


def read_bars(conn: sqlite3.Connection, symbol: str, timeframe: str) -> list[Bar]:
    return [
        Bar(r["ts"], r["open"], r["high"], r["low"], r["close"])
        for r in conn.execute(
            "SELECT ts, open, high, low, close FROM bars"
            " WHERE symbol = ? AND timeframe = ? ORDER BY ts",
            (symbol, timeframe),
        )
    ]


def _default_fetch(url: str) -> str:
    from jamasp.net import get_with_fallback

    return get_with_fallback(url).text


def backfill(conn: sqlite3.Connection, symbol: str = SYMBOL, fetch=None) -> dict[str, int]:
    """Fetch and store every timeframe. Returns timeframe -> rows written.

    Idempotent on the primary key, which makes one command serve as both the
    initial backfill AND the daily refresh: the two calls re-walk overlapping
    history and upsert, so no separate incremental path exists to drift out
    of agreement with this one.

    Each timeframe is committed as it is derived, before the next fetch. A
    daily-endpoint failure must not cost the 730-day hourly pull that already
    succeeded.
    """
    fetch = fetch or _default_fetch
    written: dict[str, int] = {}

    hourly = parse_yahoo_bars(fetch(HOURLY_URL))
    written["1h"] = store_bars(conn, symbol, "1h", hourly)
    written["4h"] = store_bars(conn, symbol, "4h", resample(hourly, 4 * 3600))

    daily = parse_yahoo_bars(fetch(DAILY_URL))
    written["1d"] = store_bars(conn, symbol, "1d", daily)
    written["1w"] = store_bars(conn, symbol, "1w", resample_weekly(daily))
    return written
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_bars.py -v`
Expected: PASS

- [ ] **Step 5: Write the failing CLI test**

Append to `tests/test_cli.py`:

```python
def test_bars_backfill_reports_rows_per_timeframe(tmp_path, monkeypatch):
    from jamasp.ingest import bars as bars_mod

    cfg = _write_configs(tmp_path, "sources: []\n")
    dbp = tmp_path / "j.db"

    def fake_backfill(conn, symbol="GC", fetch=None):
        return {"1h": 17395, "4h": 4349, "1d": 1258, "1w": 261}

    monkeypatch.setattr(bars_mod, "backfill", fake_backfill)
    res = CliRunner().invoke(
        main, ["bars", "backfill", "--db", str(dbp), "--config-dir", str(cfg)])
    assert res.exit_code == 0, res.output
    assert "1h=17395" in res.output and "1w=261" in res.output
```

- [ ] **Step 6: Run it to verify it fails**

Run: `uv run pytest tests/test_cli.py -v -k bars_backfill`
Expected: FAIL — `No such command 'bars'`

- [ ] **Step 7: Add the CLI command**

In `jamasp/cli.py`, add to the import block beside the other ingest imports (around line 29):

```python
from jamasp.ingest import bars as bars_mod
```

and add the group after the `wakeup` group:

```python
@main.group("bars")
def bars_group():
    """OHLC bars: the substrate for indicators and the ridge fit."""


@bars_group.command("backfill")
@click.option("--symbol", default=bars_mod.SYMBOL, show_default=True)
@db_opt
@cfg_opt
def bars_backfill(symbol, db_path, config_dir):
    """Fetch and store 1h/4h/1d/1w bars. Idempotent — also the daily refresh."""
    conn, _, _ = _common(db_path, config_dir)
    written = bars_mod.backfill(conn, symbol)
    click.echo(
        f"bars {symbol}: " + " ".join(f"{tf}={n}" for tf, n in written.items())
    )
```

- [ ] **Step 8: Run the whole suite**

Run: `uv run pytest -q`
Expected: PASS

- [ ] **Step 9: Verify against live data** *(needs network; if the call fails, record the failure in the commit message and continue — the offline tests are the gate)*

Run: `uv run jamasp bars backfill --db /tmp/bars-check.db`

Expected: roughly `1h=17000+ 4h=4300+ 1d=1250+ 1w=260+`, matching the spec's measured figures (17,395 hourly bars over 730d, resampling to ~4,349 4h bars). A materially smaller hourly count means Yahoo changed its serving depth — note the actual numbers in the commit message rather than adjusting the code to match.

- [ ] **Step 10: Commit**

Stage `jamasp/ingest/bars.py`, `jamasp/cli.py`, `tests/test_bars.py`, `tests/test_cli.py` and commit with:

```
feat(bars): jamasp bars backfill

Idempotent on the primary key, which makes one command serve as both the
initial backfill and the daily refresh: the two Yahoo calls re-walk
overlapping history and upsert, so no separate incremental path exists to
drift. Each timeframe commits before the next fetch, so a daily-endpoint
failure cannot cost the 730-day hourly pull that already succeeded.

INSERT OR REPLACE, not OR IGNORE: Yahoo revises the forming bar.
```

---

### Task 3: Fit configuration in `config/weights.yaml`

**Files:**
- Modify: `config/weights.yaml`
- Modify: `jamasp/config.py`
- Modify: `tests/test_config.py`

**Interfaces:**
- Consumes: `load_weights(path) -> dict` and `themes(weights) -> tuple[str, ...]` (both already exist in `jamasp/config.py`).
- Produces:
  - `SignalSpec` frozen dataclass: `name: str`, `family: str`, `timeframes: tuple[str, ...]`, `source: str` (`"bars"` or `"price_series"`), `symbol: str | None`
  - `tier_weights(weights) -> dict[int, float]`
  - `signal_specs(weights) -> tuple[SignalSpec, ...]` — declaration order preserved
  - `signal_columns(weights) -> tuple[str, ...]` — ordered `f"{name}@{tf}"` keys, 38 of them
  - `fit_config(weights) -> dict`
  - `active_pins(weights, today: str) -> dict[str, float]` — key → pinned multiplier, expired entries dropped

**Context you need:** `jamasp/config.py` already holds `load_weights` and `themes`; `themes` raises `ValueError` when the `other` slot is missing, and its docstring explains that order is data because the fit indexes columns positionally. The same reasoning governs `signals`. `panel/lib/marketmap.ts` hard-codes `TIER_WEIGHT = {5:100, 4:60, 3:30, 2:10, 1:3}` with a comment saying it mirrors this file — those values must match exactly.

- [ ] **Step 1: Extend `config/weights.yaml`**

Append to `config/weights.yaml`:

```yaml
# tier_weight: the fundamental map's area encoding, and the fit's measure of
# how much a story counts toward its theme's hourly exposure. Mirrored in
# panel/lib/marketmap.ts#TIER_WEIGHT — change both together or the map and
# the fit will disagree about what "big" means.
tier_weight:
  5: 100
  4: 60
  3: 30
  2: 10
  1: 3

# signals: the technical map's taxonomy and the fit's feature columns, in
# positional order. Adding, removing or reordering an entry invalidates every
# fitted coefficient and requires a full refit — which `jamasp weights fit`
# does unconditionally, so the cost is one timer tick, not a migration.
#
# `family` groups tiles on the technical map exactly as `theme` groups them on
# the fundamental one. All five families must stay non-empty or the map draws
# a box with nothing in it.
#
# Twelve signals are computed from bars across three timeframes; GVZ and net
# spec are external series read from `prices` and carry one timeframe each,
# because there is no such thing as a 4h CFTC print. 12*3 + 2 = 38 columns.
signals:
  - {name: sma50,     family: trend,       timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: sma200,    family: trend,       timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: macd,      family: trend,       timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: adx,       family: trend,       timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: rsi14,     family: momentum,    timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: stoch,     family: momentum,    timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: willr,     family: momentum,    timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: fib618,    family: levels,      timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: fib50,     family: levels,      timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: pivot,     family: levels,      timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: bollinger, family: levels,      timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: atr14,     family: volatility,  timeframes: ["1d", "4h", "1w"], source: bars}
  - {name: gvz,       family: volatility,  timeframes: ["1d"], source: price_series, symbol: "^GVZ"}
  - {name: net_spec,  family: positioning, timeframes: ["1d"], source: price_series, symbol: GC_NET_SPEC}

fit:
  # Forward-return horizon, in hours. The retro owns this; changing it costs
  # nothing permanent because every fit is a full refit from history.
  horizon_hours: 24
  # Ridge penalty. Shrinks coefficients toward zero, which — after the
  # beta/mean(beta) normalisation — compresses multipliers toward each other.
  ridge_alpha: 1.0
  # Below this many usable training rows the fit refuses rather than
  # publishing coefficients nobody should act on.
  min_rows: 200
  multiplier_min: 0.25
  multiplier_max: 3.0
  # A column with fewer than this many non-zero observations is reported as
  # unfitted (multiplier 1.0, dashed on the map) rather than given a
  # coefficient estimated from a handful of rows.
  min_observations: 50

# pins: retro overrides that beat the fitted value until they expire. Each
# needs a reason and an expiry — an un-expiring pin is how a fit quietly
# stops mattering. `key` is a theme slug or a signal column ("rsi14@1d").
# Expired pins lapse automatically at fit time; nobody has to remember.
pins: []
```

- [ ] **Step 2: Write the failing config tests**

Append to `tests/test_config.py` (add `import pytest` and `from pathlib import Path` at the top if they are not already present):

```python
from jamasp.config import (
    active_pins, fit_config, load_weights, signal_columns, signal_specs,
    tier_weights,
)

REAL_WEIGHTS = Path("config/weights.yaml")


def test_tier_weights_match_the_panel_constant():
    # panel/lib/marketmap.ts#TIER_WEIGHT is the same table. They encode the
    # same claim about materiality; a silent divergence means the map's areas
    # and the fit's exposures stop describing the same world.
    assert tier_weights(load_weights(REAL_WEIGHTS)) == {5: 100, 4: 60, 3: 30, 2: 10, 1: 3}


def test_signal_columns_are_thirty_eight_and_ordered():
    cols = signal_columns(load_weights(REAL_WEIGHTS))
    assert len(cols) == 38
    assert len(set(cols)) == 38
    assert cols[0] == "sma50@1d"
    assert cols[-1] == "net_spec@1d"


def test_external_signals_carry_a_symbol_and_one_timeframe():
    by_name = {s.name: s for s in signal_specs(load_weights(REAL_WEIGHTS))}
    assert by_name["gvz"].source == "price_series"
    assert by_name["gvz"].symbol == "^GVZ"
    assert by_name["gvz"].timeframes == ("1d",)
    assert by_name["net_spec"].symbol == "GC_NET_SPEC"
    # There is no such thing as a 4h CFTC print.
    assert by_name["net_spec"].timeframes == ("1d",)


def test_every_family_is_non_empty():
    fams = {s.family for s in signal_specs(load_weights(REAL_WEIGHTS))}
    assert fams == {"trend", "momentum", "levels", "volatility", "positioning"}


def test_signal_specs_rejects_a_duplicate_name(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\n"
        "signals:\n"
        "  - {name: rsi14, family: momentum, timeframes: ['1d'], source: bars}\n"
        "  - {name: rsi14, family: trend, timeframes: ['1d'], source: bars}\n"
    )
    with pytest.raises(ValueError, match="duplicate"):
        signal_specs(load_weights(p))


def test_signal_specs_rejects_an_unknown_source(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\n"
        "signals:\n"
        "  - {name: rsi14, family: momentum, timeframes: ['1d'], source: vibes}\n"
    )
    with pytest.raises(ValueError, match="source"):
        signal_specs(load_weights(p))


def test_signal_specs_rejects_a_price_series_with_no_symbol(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\n"
        "signals:\n"
        "  - {name: gvz, family: volatility, timeframes: ['1d'], source: price_series}\n"
    )
    with pytest.raises(ValueError, match="symbol"):
        signal_specs(load_weights(p))


def test_fit_config_has_the_keys_the_fit_reads():
    cfg = fit_config(load_weights(REAL_WEIGHTS))
    assert cfg["horizon_hours"] == 24
    assert cfg["multiplier_min"] == 0.25 and cfg["multiplier_max"] == 3.0
    assert cfg["ridge_alpha"] > 0 and cfg["min_rows"] > 0


def test_active_pins_drops_expired_and_keeps_live(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\nsignals: []\n"
        "pins:\n"
        "  - {key: rates_dollar, value: 1.5, reason: 'cut cycle', expires: '2026-09-01'}\n"
        "  - {key: 'rsi14@1d', value: 0.5, reason: 'noisy', expires: '2026-08-01'}\n"
    )
    assert active_pins(load_weights(p), "2026-08-20") == {"rates_dollar": 1.5}


def test_active_pins_rejects_a_pin_with_no_expiry(tmp_path):
    # An un-expiring pin is how a fit quietly stops mattering: the map keeps
    # rendering, the number keeps looking measured, and nothing ever revisits
    # the judgement that froze it.
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\nsignals: []\n"
        "pins:\n  - {key: rates_dollar, value: 1.5, reason: 'cut cycle'}\n"
    )
    with pytest.raises(ValueError, match="expires"):
        active_pins(load_weights(p), "2026-08-20")


def test_active_pins_rejects_a_pin_with_no_reason(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\nsignals: []\n"
        "pins:\n  - {key: rates_dollar, value: 1.5, expires: '2026-09-01'}\n"
    )
    with pytest.raises(ValueError, match="reason"):
        active_pins(load_weights(p), "2026-08-20")
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_config.py -v`
Expected: FAIL — `ImportError: cannot import name 'tier_weights'`

- [ ] **Step 4: Implement the accessors**

Append to `jamasp/config.py`:

```python
VALID_SIGNAL_SOURCES = ("bars", "price_series")


@dataclass(frozen=True)
class SignalSpec:
    name: str
    family: str
    timeframes: tuple[str, ...]
    source: str
    symbol: str | None = None


def tier_weights(weights: dict) -> dict[int, float]:
    """Materiality tier -> area weight, mirroring panel/lib/marketmap.ts."""
    return {int(k): float(v) for k, v in weights["tier_weight"].items()}


def signal_specs(weights: dict) -> tuple[SignalSpec, ...]:
    """The technical taxonomy, in declared order.

    Order is data, exactly as it is for `themes`: the fit indexes its feature
    columns by position, so sorting here would permute fitted coefficients
    against their labels. Duplicates and unknown sources raise rather than
    silently collapsing two columns into one or reaching for a reader that
    does not exist.
    """
    specs: list[SignalSpec] = []
    seen: set[str] = set()
    for e in weights.get("signals") or []:
        name = e["name"]
        if name in seen:
            raise ValueError(f"duplicate signal name in config/weights.yaml: {name!r}")
        seen.add(name)
        source = e.get("source", "bars")
        if source not in VALID_SIGNAL_SOURCES:
            raise ValueError(
                f"signal {name!r} has source {source!r};"
                f" expected one of {VALID_SIGNAL_SOURCES}"
            )
        if source == "price_series" and not e.get("symbol"):
            raise ValueError(f"signal {name!r} reads a price series but names no symbol")
        specs.append(SignalSpec(
            name=name, family=e["family"],
            timeframes=tuple(e["timeframes"]), source=source,
            symbol=e.get("symbol"),
        ))
    return tuple(specs)


def signal_columns(weights: dict) -> tuple[str, ...]:
    """Ordered feature-column keys, "<signal>@<timeframe>"."""
    return tuple(
        f"{s.name}@{tf}" for s in signal_specs(weights) for tf in s.timeframes
    )


def fit_config(weights: dict) -> dict:
    return weights["fit"]


def active_pins(weights: dict, today: str) -> dict[str, float]:
    """Retro overrides still in force on `today` (an ISO date, YYYY-MM-DD).

    Every pin must carry a reason and an expiry. An un-expiring pin is how a
    fit quietly stops mattering — the number keeps looking measured while
    nothing ever revisits the judgement that froze it — so this refuses one
    rather than honouring it.
    """
    out: dict[str, float] = {}
    for p in weights.get("pins") or []:
        key = p.get("key")
        if not p.get("reason"):
            raise ValueError(f"pin {key!r} has no reason")
        if not p.get("expires"):
            raise ValueError(f"pin {key!r} has no expires date")
        if str(p["expires"]) > today:
            out[key] = float(p["value"])
    return out
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_config.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

Stage `config/weights.yaml`, `jamasp/config.py`, `tests/test_config.py` and commit with:

```
feat(weights): fit configuration — tier weights, signals, pins

signals: order is data, as themes already is — the fit indexes feature
columns by position. Twelve bar-computed signals across three timeframes
plus GVZ and CFTC net spec, which carry one timeframe each because there
is no such thing as a 4h CFTC print: 38 columns, not the spec's 42.

Pins refuse to load without a reason and an expiry. An un-expiring pin is
how a fit quietly stops mattering.
```

---

### Task 4: `jamasp/indicators.py`

**Files:**
- Create: `jamasp/indicators.py`
- Create: `tests/test_indicators.py`
- Create: `scripts/capture-tv-oracle.py`
- Create: `tests/test_indicators_oracle.py`
- Create: `tests/fixtures/tv_oracle.json` *(produced by the capture script, committed)*

**Interfaces:**
- Consumes: `Bar` from `jamasp/ingest/bars.py`.
- Produces (all pure, no I/O, no config; every list is the same length as `bars`, with `None` during warm-up):
  - `sma(values: list[float], n: int) -> list[float | None]`
  - `ema(values: list[float], n: int) -> list[float | None]`
  - `stdev(values: list[float], n: int) -> list[float | None]`
  - `rsi(bars: list[Bar], n: int = 14) -> list[float | None]`
  - `atr(bars: list[Bar], n: int = 14) -> list[float | None]`
  - `macd(bars, fast=12, slow=26, signal=9) -> tuple[list[float | None], list[float | None]]` — (macd line, signal line)
  - `adx(bars, n=14) -> list[float | None]`
  - `stochastic(bars, k=14, d=3) -> tuple[list[float | None], list[float | None]]` — (%K, %D)
  - `williams_r(bars, n=14) -> list[float | None]`
  - `bollinger(bars, n=20, k=2.0) -> tuple[list[float | None], list[float | None]]` — (upper, lower)
  - `fib_levels(bars, lookback=100) -> tuple[list[float | None], list[float | None]]` — (0.618, 0.5)
  - `pivots(bars) -> tuple[list[float | None], list[float | None]]` — (R1, S1)
  - `INDICATOR_KEYS: tuple[str, ...]`
  - `compute_all(bars: list[Bar]) -> list[dict[str, float | None]]` — one dict per bar, every key in `INDICATOR_KEYS` present

`INDICATOR_KEYS` is exactly:
`("close", "sma50", "sma200", "rsi14", "atr14", "macd", "macd_signal", "adx", "stoch_k", "stoch_d", "willr", "bb_upper", "bb_lower", "fib618", "fib50", "pivot_r1", "pivot_s1")`

**Context you need:** `jamasp/ingest/prices.py`'s `_TV_BASE` table names the same indicator set TradingView serves, and those series names (`GC_RSI14`, `GC_SMA50`, …) already hold months of history in the live database. This module recomputes the same quantities from our own bars so the fit has a history to learn from; TradingView serves values at one instant only and cannot backfill.

Wilder's smoothing (used by RSI, ATR and ADX) is an EMA with `alpha = 1/n`, seeded with a simple average of the first `n` values — not `alpha = 2/(n+1)`, which is what `ema()` uses for MACD. Getting that wrong produces indicators that look plausible and disagree with every chart, so keep the two smoothers as separate, separately-tested functions.

- [ ] **Step 1: Write the failing indicator tests**

Create `tests/test_indicators.py`. Every expected value below is analytically derivable — no golden numbers copied out of a run, which would only pin whatever the first implementation happened to produce:

```python
from datetime import datetime, timedelta, timezone

import pytest

from jamasp import indicators as ind
from jamasp.ingest.bars import TS_FMT, Bar


def _ts(i, seconds=86400, start="2026-01-01T00:00:00Z"):
    """Timestamp arithmetic, not f-string day arithmetic.

    `f"2026-01-{i + 1:02d}"` produces "2026-01-40" past 31 bars — a string no
    date parser accepts. Nothing in this module parses a timestamp, so it
    would not fail here; it would fail in whichever later test first does.
    """
    base = datetime.strptime(start, TS_FMT).replace(tzinfo=timezone.utc)
    return (base + timedelta(seconds=i * seconds)).strftime(TS_FMT)


def _bars(closes, highs=None, lows=None):
    highs = highs if highs is not None else [c + 1 for c in closes]
    lows = lows if lows is not None else [c - 1 for c in closes]
    return [
        Bar(_ts(i), c, h, low, c)
        for i, (c, h, low) in enumerate(zip(closes, highs, lows))
    ]


# ---- moving averages -------------------------------------------------------

def test_sma_of_a_constant_series_is_that_constant():
    out = ind.sma([5.0] * 10, 3)
    assert out[:2] == [None, None]      # warm-up
    assert out[2:] == [5.0] * 8


def test_sma_window_is_exactly_n_values():
    # SMA3 of 1..5 at index 4 is mean(3,4,5) = 4.
    assert ind.sma([1.0, 2.0, 3.0, 4.0, 5.0], 3)[4] == pytest.approx(4.0)


def test_ema_of_a_constant_series_is_that_constant():
    out = ind.ema([7.0] * 20, 5)
    assert out[4:] == pytest.approx([7.0] * 16)


def test_stdev_of_a_constant_series_is_zero():
    assert ind.stdev([3.0] * 10, 4)[9] == pytest.approx(0.0)


# ---- RSI -------------------------------------------------------------------

def test_rsi_of_a_monotonic_rise_is_one_hundred():
    # Average loss is exactly zero, so RS is unbounded and RSI pins at 100.
    out = ind.rsi(_bars([float(i) for i in range(1, 40)]), 14)
    assert out[-1] == pytest.approx(100.0)


def test_rsi_of_a_monotonic_fall_is_zero():
    out = ind.rsi(_bars([float(i) for i in range(40, 1, -1)]), 14)
    assert out[-1] == pytest.approx(0.0)


def test_rsi_of_equal_alternating_moves_sits_near_fifty():
    # Wilder smoothing does not settle exactly on 50 for an alternating
    # series: the smoothed gain and loss swap which one absorbed the latest
    # move, so the reading oscillates in a narrow band around 50 forever.
    # A band is the true expectation here; asserting exactly 50.0 would be
    # asserting something the algorithm does not do.
    closes = [100.0 + (1.0 if i % 2 else 0.0) for i in range(60)]
    assert 40.0 < ind.rsi(_bars(closes), 14)[-1] < 60.0


def test_rsi_of_a_flat_series_is_fifty():
    # No gains AND no losses. 100 would be wrong (that is the unbroken-rise
    # answer) and a ZeroDivisionError would be worse: a flat tape has no
    # momentum either way, which is exactly what 50 means.
    assert ind.rsi(_bars([100.0] * 40), 14)[-1] == pytest.approx(50.0)


def test_rsi_warm_up_is_none():
    out = ind.rsi(_bars([float(i) for i in range(1, 20)]), 14)
    assert out[13] is None and out[14] is not None


# ---- ATR -------------------------------------------------------------------

def test_atr_of_constant_range_bars_is_that_range():
    # Every bar spans exactly 4, and each close sits mid-range so the
    # gap terms in true range never exceed high-low.
    bars = [Bar(_ts(i), 100, 102, 98, 100) for i in range(40)]
    assert ind.atr(bars, 14)[-1] == pytest.approx(4.0)


def test_atr_counts_a_gap_as_true_range():
    # Bar 2 spans 1 but gaps 10 above bar 1's close: true range is 11, not 1.
    bars = [Bar("2026-01-01T00:00:00Z", 100, 100, 99, 100),
            Bar("2026-01-02T00:00:00Z", 110, 110, 109, 110)]
    assert ind.atr(bars, 1)[-1] == pytest.approx(11.0)


# ---- MACD ------------------------------------------------------------------

def test_macd_of_a_constant_series_is_zero():
    bars = _bars([50.0] * 80)
    line, sig = ind.macd(bars)
    assert line[-1] == pytest.approx(0.0)
    assert sig[-1] == pytest.approx(0.0)


def test_macd_is_positive_in_an_uptrend():
    # Fast EMA leads slow EMA when price rises, so the line is above zero.
    line, sig = ind.macd(_bars([float(i) for i in range(1, 120)]))
    assert line[-1] > 0 and line[-1] > sig[-1]


# ---- Stochastic and Williams %R --------------------------------------------

def test_stoch_k_is_one_hundred_at_the_window_high():
    # Final close equals the window's highest high.
    closes = [10.0] * 19 + [11.0]
    bars = _bars(closes, highs=[11.0] * 20, lows=[9.0] * 20)
    k, _ = ind.stochastic(bars, k=14, d=3)
    assert k[-1] == pytest.approx(100.0)


def test_stoch_k_is_zero_at_the_window_low():
    closes = [10.0] * 19 + [9.0]
    bars = _bars(closes, highs=[11.0] * 20, lows=[9.0] * 20)
    k, _ = ind.stochastic(bars, k=14, d=3)
    assert k[-1] == pytest.approx(0.0)


def test_williams_r_is_zero_at_the_high_and_minus_hundred_at_the_low():
    high_close = _bars([10.0] * 19 + [11.0], highs=[11.0] * 20, lows=[9.0] * 20)
    low_close = _bars([10.0] * 19 + [9.0], highs=[11.0] * 20, lows=[9.0] * 20)
    assert ind.williams_r(high_close, 14)[-1] == pytest.approx(0.0)
    assert ind.williams_r(low_close, 14)[-1] == pytest.approx(-100.0)


# ---- Bollinger -------------------------------------------------------------

def test_bollinger_bands_collapse_onto_a_constant_series():
    upper, lower = ind.bollinger(_bars([25.0] * 40), n=20, k=2.0)
    assert upper[-1] == pytest.approx(25.0)
    assert lower[-1] == pytest.approx(25.0)


def test_bollinger_bands_are_symmetric_about_the_mean():
    closes = [100.0 + (i % 5) for i in range(40)]
    upper, lower = ind.bollinger(_bars(closes), n=20, k=2.0)
    mid = ind.sma(closes, 20)[-1]
    assert (upper[-1] + lower[-1]) / 2 == pytest.approx(mid)


# ---- ADX -------------------------------------------------------------------

def test_adx_is_high_in_a_clean_trend():
    # A pure staircase has +DI dominant every bar, so ADX saturates high.
    out = ind.adx(_bars([float(i) for i in range(1, 80)]), 14)
    assert out[-1] > 40


def test_adx_is_low_in_a_flat_market():
    bars = [Bar(_ts(i), 100, 101, 99, 100) for i in range(80)]
    out = ind.adx(bars, 14)
    assert out[-1] is not None and out[-1] < 25


# ---- Fibonacci and pivots --------------------------------------------------

def test_fib_levels_are_retracements_of_the_lookback_range():
    # Range 100..200 -> 0.618 retracement at 200 - 0.618*100 = 138.2,
    # midpoint at 150.
    closes = [100.0 + i for i in range(101)]   # 100 .. 200
    f618, f50 = ind.fib_levels(_bars(closes, highs=closes, lows=closes),
                               lookback=101)
    assert f618[-1] == pytest.approx(138.2)
    assert f50[-1] == pytest.approx(150.0)


def test_pivots_come_from_the_PREVIOUS_bar():
    # P = (110 + 90 + 100)/3 = 100; R1 = 2P - L = 110; S1 = 2P - H = 90.
    # Reading the CURRENT bar would be lookahead: a pivot is a level you
    # trade the next session against, not one you knew intrabar.
    bars = [Bar("2026-01-01T00:00:00Z", 100, 110, 90, 100),
            Bar("2026-01-02T00:00:00Z", 100, 500, 1, 100)]
    r1, s1 = ind.pivots(bars)
    assert r1[0] is None and s1[0] is None
    assert r1[1] == pytest.approx(110.0)
    assert s1[1] == pytest.approx(90.0)


# ---- compute_all -----------------------------------------------------------

def test_compute_all_returns_one_dict_per_bar_with_every_key():
    bars = _bars([100.0 + (i % 7) for i in range(260)])
    rows = ind.compute_all(bars)
    assert len(rows) == len(bars)
    for row in rows:
        assert set(row) == set(ind.INDICATOR_KEYS)
    assert rows[-1]["sma200"] is not None
    assert rows[-1]["close"] == pytest.approx(bars[-1].close)


def test_compute_all_leaves_warm_up_keys_none_rather_than_guessing():
    rows = ind.compute_all(_bars([100.0] * 5))
    assert rows[-1]["sma200"] is None
    assert rows[-1]["close"] is not None


def test_compute_all_of_an_empty_series_is_empty():
    assert ind.compute_all([]) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_indicators.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.indicators'`

- [ ] **Step 3: Implement the indicators**

Create `jamasp/indicators.py`. Two smoothing conventions live here and must not be conflated: `ema` uses `alpha = 2/(n+1)` (MACD, Bollinger's cousins), while `_wilder` uses `alpha = 1/n` seeded on a simple average (RSI, ATR, ADX). Write both, keep them separate.

```python
"""Indicator math over an OHLC bar series. Pure: no I/O, no config.

TradingView serves these values at one instant and cannot backfill, so the
fit — which needs a history of states — has to compute them itself.
tests/test_indicators_oracle.py cross-checks the daily set against
TradingView's own numbers, which is what makes "we compute them ourselves"
a checkable claim rather than a second implementation nobody can compare.

Two smoothing conventions appear below and must not be conflated. `ema` is
the classic alpha = 2/(n+1) exponential average, used by MACD. `_wilder` is
alpha = 1/n seeded with a simple average of the first n values, which is what
RSI, ATR and ADX are defined against. Substituting one for the other produces
curves that look entirely plausible and disagree with every chart.
"""
from __future__ import annotations

from statistics import pstdev

from jamasp.ingest.bars import Bar

INDICATOR_KEYS = (
    "close", "sma50", "sma200", "rsi14", "atr14", "macd", "macd_signal",
    "adx", "stoch_k", "stoch_d", "willr", "bb_upper", "bb_lower",
    "fib618", "fib50", "pivot_r1", "pivot_s1",
)


def sma(values: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if n <= 0:
        return out
    running = 0.0
    for i, v in enumerate(values):
        running += v
        if i >= n:
            running -= values[i - n]
        if i >= n - 1:
            out[i] = running / n
    return out


def ema(values: list[float], n: int) -> list[float | None]:
    """alpha = 2/(n+1), seeded with the simple average of the first n values."""
    out: list[float | None] = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    alpha = 2.0 / (n + 1)
    prev = sum(values[:n]) / n
    out[n - 1] = prev
    for i in range(n, len(values)):
        prev = alpha * values[i] + (1 - alpha) * prev
        out[i] = prev
    return out


def _wilder(values: list[float], n: int) -> list[float | None]:
    """alpha = 1/n, seeded with the simple average of the first n values."""
    out: list[float | None] = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    prev = sum(values[:n]) / n
    out[n - 1] = prev
    for i in range(n, len(values)):
        prev = prev + (values[i] - prev) / n
        out[i] = prev
    return out


def stdev(values: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    for i in range(n - 1, len(values)):
        out[i] = pstdev(values[i - n + 1 : i + 1])
    return out


def rsi(bars: list[Bar], n: int = 14) -> list[float | None]:
    closes = [b.close for b in bars]
    gains = [0.0] + [max(0.0, closes[i] - closes[i - 1]) for i in range(1, len(closes))]
    losses = [0.0] + [max(0.0, closes[i - 1] - closes[i]) for i in range(1, len(closes))]
    # Skip index 0: it has no prior close, so its 0.0 is padding rather than a
    # measurement, and averaging it in would bias the first real reading.
    avg_gain = _wilder(gains[1:], n)
    avg_loss = _wilder(losses[1:], n)
    out: list[float | None] = [None] * len(bars)
    for i in range(1, len(bars)):
        g, loss = avg_gain[i - 1], avg_loss[i - 1]
        if g is None or loss is None:
            continue
        if g == 0 and loss == 0:
            # A flat tape has no momentum either way. 100 would be the
            # unbroken-rise answer applied to a series that never rose.
            out[i] = 50.0
        elif loss == 0:
            # Unbroken rise: RS is unbounded and RSI pins at 100, which is
            # the definition, not a divide-by-zero to dodge.
            out[i] = 100.0
        else:
            out[i] = 100.0 - 100.0 / (1 + g / loss)
    return out


def _true_ranges(bars: list[Bar]) -> list[float]:
    tr = [bars[0].high - bars[0].low] if bars else []
    for i in range(1, len(bars)):
        prev_close = bars[i - 1].close
        tr.append(max(bars[i].high - bars[i].low,
                      abs(bars[i].high - prev_close),
                      abs(bars[i].low - prev_close)))
    return tr


def atr(bars: list[Bar], n: int = 14) -> list[float | None]:
    return _wilder(_true_ranges(bars), n)


def macd(bars: list[Bar], fast: int = 12, slow: int = 26, signal: int = 9
         ) -> tuple[list[float | None], list[float | None]]:
    closes = [b.close for b in bars]
    f, s = ema(closes, fast), ema(closes, slow)
    line: list[float | None] = [
        None if f[i] is None or s[i] is None else f[i] - s[i]
        for i in range(len(closes))
    ]
    # The signal line is an EMA of the MACD line, which only exists from the
    # slow EMA's warm-up onward; feeding the Nones in as zeros would drag it
    # toward zero for the first `signal` bars of real data.
    live = [v for v in line if v is not None]
    sig_live = ema(live, signal)
    sig: list[float | None] = [None] * len(closes)
    offset = len(closes) - len(live)
    for i, v in enumerate(sig_live):
        sig[offset + i] = v
    return line, sig


def adx(bars: list[Bar], n: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(bars)
    if len(bars) < 2:
        return out
    plus_dm, minus_dm = [0.0], [0.0]
    for i in range(1, len(bars)):
        up = bars[i].high - bars[i - 1].high
        down = bars[i - 1].low - bars[i].low
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
    tr = _true_ranges(bars)
    atr_s = _wilder(tr[1:], n)
    plus_s = _wilder(plus_dm[1:], n)
    minus_s = _wilder(minus_dm[1:], n)

    dx: list[float] = []
    dx_index: list[int] = []
    for i in range(1, len(bars)):
        a, p, m = atr_s[i - 1], plus_s[i - 1], minus_s[i - 1]
        if a is None or p is None or m is None or a == 0:
            continue
        pdi, mdi = 100 * p / a, 100 * m / a
        total = pdi + mdi
        dx.append(0.0 if total == 0 else 100 * abs(pdi - mdi) / total)
        dx_index.append(i)

    smoothed = _wilder(dx, n)
    for k, v in enumerate(smoothed):
        if v is not None:
            out[dx_index[k]] = v
    return out


def stochastic(bars: list[Bar], k: int = 14, d: int = 3
               ) -> tuple[list[float | None], list[float | None]]:
    k_line: list[float | None] = [None] * len(bars)
    for i in range(k - 1, len(bars)):
        window = bars[i - k + 1 : i + 1]
        hi = max(b.high for b in window)
        lo = min(b.low for b in window)
        # A flat window has no range to place the close within; 50 is the
        # honest "neither" rather than a division by zero.
        k_line[i] = 50.0 if hi == lo else 100 * (bars[i].close - lo) / (hi - lo)
    live = [v for v in k_line if v is not None]
    d_live = sma(live, d)
    d_line: list[float | None] = [None] * len(bars)
    offset = len(bars) - len(live)
    for i, v in enumerate(d_live):
        d_line[offset + i] = v
    return k_line, d_line


def williams_r(bars: list[Bar], n: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(bars)
    for i in range(n - 1, len(bars)):
        window = bars[i - n + 1 : i + 1]
        hi = max(b.high for b in window)
        lo = min(b.low for b in window)
        out[i] = -50.0 if hi == lo else -100 * (hi - bars[i].close) / (hi - lo)
    return out


def bollinger(bars: list[Bar], n: int = 20, k: float = 2.0
              ) -> tuple[list[float | None], list[float | None]]:
    closes = [b.close for b in bars]
    mid, sd = sma(closes, n), stdev(closes, n)
    upper = [None if mid[i] is None else mid[i] + k * sd[i] for i in range(len(closes))]
    lower = [None if mid[i] is None else mid[i] - k * sd[i] for i in range(len(closes))]
    return upper, lower


def fib_levels(bars: list[Bar], lookback: int = 100
               ) -> tuple[list[float | None], list[float | None]]:
    """Retracements of the lookback range, measured DOWN from its high."""
    f618: list[float | None] = [None] * len(bars)
    f50: list[float | None] = [None] * len(bars)
    for i in range(lookback - 1, len(bars)):
        window = bars[i - lookback + 1 : i + 1]
        hi = max(b.high for b in window)
        lo = min(b.low for b in window)
        f618[i] = hi - 0.618 * (hi - lo)
        f50[i] = hi - 0.5 * (hi - lo)
    return f618, f50


def pivots(bars: list[Bar]) -> tuple[list[float | None], list[float | None]]:
    """Classic R1/S1 from the PREVIOUS bar.

    Reading the current bar would be lookahead: a pivot is a level you trade
    the next session against, not one you knew while the session was forming.
    """
    r1: list[float | None] = [None] * len(bars)
    s1: list[float | None] = [None] * len(bars)
    for i in range(1, len(bars)):
        prev = bars[i - 1]
        p = (prev.high + prev.low + prev.close) / 3
        r1[i] = 2 * p - prev.low
        s1[i] = 2 * p - prev.high
    return r1, s1


def compute_all(bars: list[Bar]) -> list[dict[str, float | None]]:
    """One dict per bar, every INDICATOR_KEYS key present (None during warm-up)."""
    if not bars:
        return []
    closes = [b.close for b in bars]
    macd_line, macd_sig = macd(bars)
    k_line, d_line = stochastic(bars)
    bb_u, bb_l = bollinger(bars)
    f618, f50 = fib_levels(bars)
    r1, s1 = pivots(bars)
    cols = {
        "close": list(closes), "sma50": sma(closes, 50), "sma200": sma(closes, 200),
        "rsi14": rsi(bars), "atr14": atr(bars), "macd": macd_line,
        "macd_signal": macd_sig, "adx": adx(bars), "stoch_k": k_line,
        "stoch_d": d_line, "willr": williams_r(bars), "bb_upper": bb_u,
        "bb_lower": bb_l, "fib618": f618, "fib50": f50,
        "pivot_r1": r1, "pivot_s1": s1,
    }
    return [{key: cols[key][i] for key in INDICATOR_KEYS} for i in range(len(bars))]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_indicators.py -v`
Expected: PASS. If ADX's flat-market test fails at exactly 25, do not widen the bound — check that `_wilder` seeds on a simple average and that `plus_dm`/`minus_dm` use the strict `>` comparisons above.

- [ ] **Step 5: Write the capture script**

Create `scripts/capture-tv-oracle.py`:

```python
#!/usr/bin/env python3
"""Record a TradingView / Yahoo pair for tests/test_indicators_oracle.py.

Run once, commit the fixture. The test then runs offline forever, and
re-running this refreshes it against a newer market instant.

    uv run python scripts/capture-tv-oracle.py

Both endpoints are ones Jamasp already polls: the TradingView scanner behind
`tv_gc_technicals` and the Yahoo chart API behind `gold_spot`.
"""
import json
from pathlib import Path

from jamasp.ingest.bars import DAILY_URL, parse_yahoo_bars
from jamasp.net import get_with_fallback

TV_URL = (
    "https://scanner.tradingview.com/symbol?symbol=COMEX%3AGC1!"
    "&fields=close,RSI,SMA50,SMA200,ATR&no_404=true"
)
OUT = Path("tests/fixtures/tv_oracle.json")

tv = json.loads(get_with_fallback(TV_URL).text)
bars = parse_yahoo_bars(get_with_fallback(DAILY_URL).text)

OUT.write_text(json.dumps({
    "captured_at": bars[-1].ts,
    "tv": {k: tv[k] for k in ("close", "RSI", "SMA50", "SMA200", "ATR")},
    "bars": [list(b) for b in bars],
}, indent=1))
print(f"wrote {OUT} — {len(bars)} bars, TV close {tv['close']}")
```

- [ ] **Step 6: Capture the fixture**

Run: `uv run python scripts/capture-tv-oracle.py`
Expected: `wrote tests/fixtures/tv_oracle.json — 1200+ bars, TV close <number>`

If the capture fails (network, endpoint change), do **not** stall: write `docs/todo/` entry `005-tv-oracle-fixture.md` recording what failed, per the convention in `docs/todo/README.md`, and continue. The offline tests in Step 1 are the gate; the oracle is the cross-check.

- [ ] **Step 7: Write the oracle test**

Create `tests/test_indicators_oracle.py`:

```python
"""Cross-check our indicators against TradingView's own numbers.

This is what makes "we compute them ourselves" a checkable claim rather than
a second implementation nobody can compare.

The two series are NOT identical instruments: TradingView reads COMEX:GC1!,
a continuous front-month contract, while our bars are Yahoo's GC=F. Roll
conventions and session boundaries differ, so the tolerances below are wide
on purpose. They are wide enough to survive that difference and far too tight
to survive a wrong smoothing constant, an off-by-one window, or a close-stamped
bar — which is exactly the class of error this test exists to catch.
"""
import json
from pathlib import Path

import pytest

from jamasp import indicators as ind
from jamasp.ingest.bars import Bar

FIXTURE = Path(__file__).parent / "fixtures" / "tv_oracle.json"


@pytest.fixture(scope="module")
def oracle():
    if not FIXTURE.exists():
        pytest.skip("run scripts/capture-tv-oracle.py to record the fixture")
    raw = json.loads(FIXTURE.read_text())
    return raw["tv"], [Bar(*b) for b in raw["bars"]]


def test_our_close_tracks_tradingviews(oracle):
    tv, bars = oracle
    assert bars[-1].close == pytest.approx(tv["close"], rel=0.02)


def test_rsi14_agrees_with_tradingview(oracle):
    tv, bars = oracle
    ours = ind.rsi(bars, 14)[-1]
    # RSI is bounded 0-100. 8 points is roughly the spread two different
    # front-month series produce; a wrong smoother moves it by 20+.
    assert ours == pytest.approx(tv["RSI"], abs=8.0)


def test_sma50_and_sma200_agree_with_tradingview(oracle):
    tv, bars = oracle
    closes = [b.close for b in bars]
    assert ind.sma(closes, 50)[-1] == pytest.approx(tv["SMA50"], rel=0.02)
    assert ind.sma(closes, 200)[-1] == pytest.approx(tv["SMA200"], rel=0.02)


def test_atr14_agrees_with_tradingview(oracle):
    tv, bars = oracle
    # ATR is the loosest of the four: it reads highs and lows, which is where
    # two different contracts' session definitions diverge most.
    assert ind.atr(bars, 14)[-1] == pytest.approx(tv["ATR"], rel=0.35)
```

- [ ] **Step 8: Run the oracle test**

Run: `uv run pytest tests/test_indicators_oracle.py -v`
Expected: PASS (or SKIP if Step 6's capture failed).

If a test FAILS, that is information, not a nuisance. Print the measured pair, then decide: a small overshoot on `ATR` or `RSI` is the GC1!/GC=F difference and the tolerance may be widened **with a comment recording the measured delta**. A miss on `SMA50` or `SMA200` is not — those are plain means of closes and cannot legitimately differ by more than the contract spread, so a large gap means our bars or our window are wrong. Fix the code, not the tolerance.

- [ ] **Step 9: Run the whole suite and commit**

Run: `uv run pytest -q`
Expected: PASS

Stage `jamasp/indicators.py`, `tests/test_indicators.py`, `scripts/capture-tv-oracle.py`, `tests/test_indicators_oracle.py`, `tests/fixtures/tv_oracle.json` and commit with:

```
feat(indicators): indicator math over bar series, with a TradingView oracle

TradingView serves values at one instant and cannot backfill, so the fit —
which needs a history of states — computes them here. The oracle test is
what makes that a checkable claim rather than a second implementation
nobody can compare.

Two smoothing conventions live in this module and must not be conflated:
ema() is alpha = 2/(n+1) for MACD, _wilder() is alpha = 1/n seeded on a
simple average for RSI, ATR and ADX. Substituting one for the other
produces curves that look plausible and disagree with every chart.

Every unit-test expectation is analytically derivable — RSI of a monotonic
rise is exactly 100, ATR of constant-range bars is exactly that range —
rather than a golden number copied from a run, which would only pin
whatever the first implementation happened to produce.
```

---

### Task 5: `jamasp/signals.py`, the `signal_states` table, and `jamasp signals refresh`

**Files:**
- Create: `jamasp/signals.py`
- Create: `tests/test_signals.py`
- Modify: `jamasp/db.py` (add `signal_states`)
- Modify: `jamasp/ingest/bars.py` (add `TIMEFRAME_SECONDS` and `close_ts`)
- Modify: `jamasp/cli.py` (add the `signals` group and `refresh`)
- Modify: `tests/test_bars.py`, `tests/test_db.py`, `tests/test_cli.py`

**Interfaces:**
- Consumes: `SignalSpec`, `signal_specs`, `signal_columns` (Task 3); `compute_all`, `INDICATOR_KEYS` (Task 4); `Bar`, `read_bars` (Tasks 1–2).
- Produces:
  - In `jamasp/ingest/bars.py`: `TIMEFRAME_SECONDS: dict[str, int]` = `{"1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800}`; `close_ts(ts: str, timeframe: str) -> str`
  - In `jamasp/signals.py`:
    - `clamp(x: float) -> float`
    - `CLASSIFIERS: dict[str, Callable[[dict], float | None]]`
    - `classify(name: str, ctx: dict) -> float | None`
    - `bar_states(name: str, bars: list[Bar]) -> list[tuple[str, float]]` — `(close_ts_of_bar, state)`, warm-up bars omitted; caller supplies the timeframe via `close_ts`
    - `series_states(name: str, points: list[tuple[str, float]]) -> list[tuple[str, float]]` — for `price_series` signals
    - `refresh(conn, weights, symbol: str = "GC") -> int` — rows written to `signal_states`
  - CLI: `jamasp signals refresh`

**The sign convention, which everything downstream depends on:** every state is in **[−1, +1] where positive is bullish for gold**. RSI 30 reads +1, RSI 70 reads −1. A single inverted classifier would hand the fit a coefficient with the wrong sign and the map a tile with the wrong colour, and neither would look broken — which is why Step 1 pins the convention with a test per classifier rather than trusting the code to read correctly.

**The classifier definitions.** Each takes a context dict of indicator values and returns a state, or `None` when a required input is missing:

| signal | state |
|---|---|
| `rsi14` | `clamp((50 - rsi14) / 20)` — oversold is bullish |
| `stoch` | `clamp((50 - stoch_k) / 30)` |
| `willr` | `clamp((-50 - willr) / 30)` — W%R runs −100..0, midpoint −50 |
| `macd` | `clamp((macd - macd_signal) / (0.5 * atr14))` — ATR-normalised so it is scale-free |
| `adx` | `clamp(adx / 40) * sign(close - sma50)` — strength is directionless, so it is signed by the regime it is measuring |
| `sma50` | `clamp((close - sma50) / atr14)` |
| `sma200` | `clamp((close - sma200) / (2 * atr14))` |
| `bollinger` | `clamp((0.5 - pos) * 4)` where `pos = (close - bb_lower) / (bb_upper - bb_lower)` — mean-reversion: at the lower band is bullish |
| `atr14` | `clamp((atr14 / atr14_avg - 1) * 2)` — volatility expansion is mildly gold-supportive |
| `fib618` | `clamp((close - fib618) / atr14)` |
| `fib50` | `clamp((close - fib50) / atr14)` |
| `pivot` | `clamp((close - mid) / half)` where `mid = (pivot_r1 + pivot_s1) / 2`, `half = (pivot_r1 - pivot_s1) / 2` |
| `gvz` | `clamp((value / value_avg - 1) * 2)` |
| `net_spec` | `clamp((value - value_avg) / value_sd / 2)` |

`atr14`'s and `gvz`'s priors are the weakest here — "rising vol is gold-supportive" is a claim, not a law. That is exactly what the fit is for: a wrong prior shows up as a coefficient near zero (the signal is noise) or a negative one (the prior is backwards), and both are reported rather than buried.

- [ ] **Step 1: Add the `signal_states` table**

In `jamasp/db.py`, append to `SCHEMA`:

```sql
-- Current technical states for the technical map, in [-1, +1] where positive
-- is bullish for gold. Written by `jamasp signals refresh`; read by the panel.
--
-- ts is the CLOSE time of the bar the state was computed from, not that
-- bar's open: a state derived from a daily bar is not knowable until that day
-- ends. Storing the open time would let the panel show a state hours before
-- it existed, and would let the fit train on it.
--
-- The fit does NOT read this table. It recomputes every historical state from
-- bars, so a refit is reproducible from bars alone and cannot inherit a state
-- written by an older version of a classifier.
CREATE TABLE IF NOT EXISTS signal_states (
    key   TEXT NOT NULL,   -- "<signal>@<timeframe>", e.g. "rsi14@1d"
    ts    TEXT NOT NULL,   -- bar CLOSE time, UTC
    value REAL NOT NULL,   -- [-1, +1], positive = bullish for gold
    PRIMARY KEY (key, ts)
);
CREATE INDEX IF NOT EXISTS idx_signal_states_key_ts ON signal_states(key, ts DESC);
```

Add to `tests/test_db.py`:

```python
def test_signal_states_table_exists(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(signal_states)")}
    assert cols == {"key", "ts", "value"}
```

- [ ] **Step 2: Write the failing timeframe test**

Append to `tests/test_bars.py`:

```python
from jamasp.ingest.bars import TIMEFRAME_SECONDS, close_ts


def test_close_ts_is_open_plus_one_period():
    assert close_ts("2026-01-05T00:00:00Z", "1h") == "2026-01-05T01:00:00Z"
    assert close_ts("2026-01-05T00:00:00Z", "4h") == "2026-01-05T04:00:00Z"
    assert close_ts("2026-01-05T00:00:00Z", "1d") == "2026-01-06T00:00:00Z"
    assert close_ts("2026-01-05T00:00:00Z", "1w") == "2026-01-12T00:00:00Z"


def test_timeframe_seconds_covers_every_stored_timeframe():
    assert set(TIMEFRAME_SECONDS) == {"1h", "4h", "1d", "1w"}
```

- [ ] **Step 3: Add the timeframe helpers**

Append to `jamasp/ingest/bars.py`:

```python
TIMEFRAME_SECONDS = {"1h": 3600, "4h": 4 * 3600, "1d": 86400, "1w": 7 * 86400}


def close_ts(ts: str, timeframe: str) -> str:
    """The moment a bar opening at `ts` finished forming.

    The separation between a bar's open and its close is the whole
    no-lookahead guarantee: a state derived from a daily bar is not knowable
    until that day ends, so anything reading states as of some instant `t`
    must compare against this, never against the stored `ts`.
    """
    return _fmt(_epoch(ts) + TIMEFRAME_SECONDS[timeframe])
```

Run: `uv run pytest tests/test_bars.py tests/test_db.py -v`
Expected: PASS

- [ ] **Step 4: Write the failing signal tests**

Create `tests/test_signals.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from jamasp import signals
from jamasp.config import load_weights, signal_specs
from jamasp.ingest.bars import TS_FMT, Bar


def test_clamp_bounds_to_the_unit_interval():
    assert signals.clamp(5.0) == 1.0
    assert signals.clamp(-5.0) == -1.0
    assert signals.clamp(0.25) == 0.25


# ---- the sign convention, pinned classifier by classifier -------------------
# Positive is bullish for gold. A single inverted classifier hands the fit a
# coefficient with the wrong sign and the map a tile with the wrong colour,
# and neither looks broken. These are the tests that would catch it.

def test_rsi_oversold_is_bullish_and_overbought_is_bearish():
    assert signals.classify("rsi14", {"rsi14": 30.0}) == pytest.approx(1.0)
    assert signals.classify("rsi14", {"rsi14": 70.0}) == pytest.approx(-1.0)
    assert signals.classify("rsi14", {"rsi14": 50.0}) == pytest.approx(0.0)


def test_stoch_oversold_is_bullish():
    assert signals.classify("stoch", {"stoch_k": 20.0}) == pytest.approx(1.0)
    assert signals.classify("stoch", {"stoch_k": 80.0}) == pytest.approx(-1.0)
    assert signals.classify("stoch", {"stoch_k": 50.0}) == pytest.approx(0.0)


def test_willr_oversold_is_bullish():
    # W%R runs -100 (at the low) to 0 (at the high); its midpoint is -50.
    assert signals.classify("willr", {"willr": -80.0}) == pytest.approx(1.0)
    assert signals.classify("willr", {"willr": -20.0}) == pytest.approx(-1.0)
    assert signals.classify("willr", {"willr": -50.0}) == pytest.approx(0.0)


def test_macd_above_signal_is_bullish():
    ctx = {"macd": 5.0, "macd_signal": 0.0, "atr14": 10.0}
    assert signals.classify("macd", ctx) == pytest.approx(1.0)
    assert signals.classify("macd", {**ctx, "macd": -5.0}) == pytest.approx(-1.0)
    assert signals.classify("macd", {**ctx, "macd": 0.0}) == pytest.approx(0.0)


def test_adx_is_signed_by_the_regime_it_measures():
    # Strength alone says nothing about direction, so a strong trend below the
    # 50DMA must read bearish, not "strong".
    up = {"adx": 40.0, "close": 110.0, "sma50": 100.0}
    down = {"adx": 40.0, "close": 90.0, "sma50": 100.0}
    assert signals.classify("adx", up) == pytest.approx(1.0)
    assert signals.classify("adx", down) == pytest.approx(-1.0)


def test_close_above_the_moving_averages_is_bullish():
    assert signals.classify(
        "sma50", {"close": 110.0, "sma50": 100.0, "atr14": 10.0}) == pytest.approx(1.0)
    assert signals.classify(
        "sma50", {"close": 90.0, "sma50": 100.0, "atr14": 10.0}) == pytest.approx(-1.0)
    assert signals.classify(
        "sma200", {"close": 120.0, "sma200": 100.0, "atr14": 10.0}) == pytest.approx(1.0)


def test_bollinger_reads_mean_reversion_not_momentum():
    # At the lower band is BULLISH. This is the one classifier whose sign a
    # reader is most likely to assume backwards.
    low = {"close": 90.0, "bb_upper": 110.0, "bb_lower": 90.0}
    high = {"close": 110.0, "bb_upper": 110.0, "bb_lower": 90.0}
    mid = {"close": 100.0, "bb_upper": 110.0, "bb_lower": 90.0}
    assert signals.classify("bollinger", low) == pytest.approx(1.0)
    assert signals.classify("bollinger", high) == pytest.approx(-1.0)
    assert signals.classify("bollinger", mid) == pytest.approx(0.0)


def test_volatility_expansion_reads_bullish():
    assert signals.classify(
        "atr14", {"atr14": 15.0, "atr14_avg": 10.0}) == pytest.approx(1.0)
    assert signals.classify(
        "atr14", {"atr14": 10.0, "atr14_avg": 10.0}) == pytest.approx(0.0)


def test_close_above_the_fib_levels_is_bullish():
    assert signals.classify(
        "fib618", {"close": 148.2, "fib618": 138.2, "atr14": 10.0}) == pytest.approx(1.0)
    assert signals.classify(
        "fib50", {"close": 140.0, "fib50": 150.0, "atr14": 10.0}) == pytest.approx(-1.0)


def test_pivot_places_the_close_within_the_r1_s1_band():
    band = {"pivot_r1": 110.0, "pivot_s1": 90.0}
    assert signals.classify("pivot", {**band, "close": 110.0}) == pytest.approx(1.0)
    assert signals.classify("pivot", {**band, "close": 90.0}) == pytest.approx(-1.0)
    assert signals.classify("pivot", {**band, "close": 100.0}) == pytest.approx(0.0)


def test_external_series_classifiers():
    assert signals.classify(
        "gvz", {"value": 15.0, "value_avg": 10.0}) == pytest.approx(1.0)
    assert signals.classify(
        "net_spec", {"value": 30.0, "value_avg": 10.0, "value_sd": 10.0}
    ) == pytest.approx(1.0)


# ---- degenerate inputs ------------------------------------------------------

def test_classify_returns_none_when_an_input_is_missing():
    assert signals.classify("sma50", {"close": 100.0, "sma50": 100.0}) is None
    assert signals.classify("rsi14", {}) is None


def test_classify_returns_none_rather_than_dividing_by_zero():
    assert signals.classify(
        "sma50", {"close": 100.0, "sma50": 90.0, "atr14": 0.0}) is None
    assert signals.classify(
        "bollinger", {"close": 100.0, "bb_upper": 100.0, "bb_lower": 100.0}) is None
    assert signals.classify(
        "pivot", {"close": 100.0, "pivot_r1": 100.0, "pivot_s1": 100.0}) is None


def test_classify_raises_on_an_unknown_signal_name():
    # A typo in config/weights.yaml must fail loudly at fit time, not produce
    # a silently absent feature column.
    with pytest.raises(KeyError):
        signals.classify("vibes", {})


def test_every_configured_signal_has_a_classifier():
    names = {s.name for s in signal_specs(load_weights())}
    assert names <= set(signals.CLASSIFIERS)


def test_every_classifier_output_is_within_the_unit_interval():
    # Extreme, absurd inputs must still clamp: an unclamped state would blow
    # up a whole feature column's scale in the fit.
    extreme = {
        "rsi14": 0.0, "stoch_k": 100.0, "willr": -100.0, "macd": 1e6,
        "macd_signal": -1e6, "atr14": 1e-3, "atr14_avg": 1e-6, "adx": 100.0,
        "close": 1e6, "sma50": 1.0, "sma200": 1.0, "bb_upper": 2.0,
        "bb_lower": 1.0, "fib618": 1.0, "fib50": 1.0, "pivot_r1": 2.0,
        "pivot_s1": 1.0, "value": 1e9, "value_avg": 1.0, "value_sd": 1e-9,
    }
    for name in signals.CLASSIFIERS:
        v = signals.classify(name, extreme)
        assert v is None or -1.0 <= v <= 1.0, name


# ---- history ----------------------------------------------------------------

def _day(i, start="2026-01-01T00:00:00Z"):
    """Date arithmetic, not f-string day arithmetic.

    `f"2026-01-{i + 1:02d}"` yields "2026-01-40" past 31 bars, and
    jamasp.ingest.bars.close_ts parses these strings — so the shortcut fails
    loudly here rather than quietly.
    """
    base = datetime.strptime(start, TS_FMT).replace(tzinfo=timezone.utc)
    return (base + timedelta(days=i)).strftime(TS_FMT)


def _rising(n):
    return [Bar(_day(i), 100.0 + i, 101.0 + i, 99.0 + i, 100.0 + i)
            for i in range(n)]


def test_bar_states_skips_warm_up_and_stamps_the_bar_CLOSE():
    out = signals.bar_states("rsi14", _rising(40), "1d")
    assert out, "expected states once RSI has warmed up"
    first_ts, _ = out[0]
    # 40 rising daily bars starting 2026-01-01: RSI warms at bar 15
    # (index 14, 2026-01-15), whose close is the NEXT midnight. A state
    # stamped with the open would be readable a full day before it existed.
    assert first_ts == "2026-01-16T00:00:00Z"
    assert all(-1.0 <= v <= 1.0 for _, v in out)


def test_bar_states_of_a_rising_series_is_bearish_for_rsi():
    # Unbroken rise -> RSI 100 -> the mean-reversion read is maximally bearish.
    out = signals.bar_states("rsi14", _rising(60), "1d")
    assert out[-1][1] == pytest.approx(-1.0)
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `uv run pytest tests/test_signals.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.signals'`

- [ ] **Step 6: Implement `jamasp/signals.py`**

```python
"""Raw indicator values -> a state in [-1, +1], positive = bullish for gold.

Pure: no I/O, no config, no database. `refresh` at the bottom is the one
exception and takes its connection as an argument.

This layer is ours regardless of where raw values come from. TradingView
serves values, not calls, and its aggregate Recommend.* gauges stay excluded
because neither map produces an aggregate verdict (config/sources.yaml:326).

The sign convention is load-bearing and easy to get backwards, especially for
the mean-reversion reads: RSI 30 is +1 (oversold is bullish), the lower
Bollinger band is +1, and ADX — which measures strength, not direction — is
signed by the regime it is measuring rather than read as bullish on its own.
tests/test_signals.py pins each of these individually.
"""
from __future__ import annotations

import sqlite3
from typing import Callable

from jamasp import indicators as ind
from jamasp.config import signal_specs
from jamasp.ingest.bars import Bar, close_ts, read_bars


def clamp(x: float) -> float:
    return max(-1.0, min(1.0, x))


def _need(ctx: dict, *keys: str) -> tuple | None:
    """The values for `keys`, or None if any is missing."""
    vals = tuple(ctx.get(k) for k in keys)
    return None if any(v is None for v in vals) else vals


def _rsi(ctx):
    v = _need(ctx, "rsi14")
    return None if v is None else clamp((50 - v[0]) / 20)


def _stoch(ctx):
    v = _need(ctx, "stoch_k")
    return None if v is None else clamp((50 - v[0]) / 30)


def _willr(ctx):
    v = _need(ctx, "willr")
    return None if v is None else clamp((-50 - v[0]) / 30)


def _macd(ctx):
    v = _need(ctx, "macd", "macd_signal", "atr14")
    if v is None or v[2] <= 0:
        return None
    return clamp((v[0] - v[1]) / (0.5 * v[2]))


def _adx(ctx):
    v = _need(ctx, "adx", "close", "sma50")
    if v is None:
        return None
    direction = 1.0 if v[1] > v[2] else (-1.0 if v[1] < v[2] else 0.0)
    return clamp(v[0] / 40) * direction


def _vs_level(key: str, divisor: float = 1.0):
    def f(ctx):
        v = _need(ctx, "close", key, "atr14")
        if v is None or v[2] <= 0:
            return None
        return clamp((v[0] - v[1]) / (divisor * v[2]))
    return f


def _bollinger(ctx):
    v = _need(ctx, "close", "bb_upper", "bb_lower")
    if v is None or v[1] <= v[2]:
        return None
    pos = (v[0] - v[2]) / (v[1] - v[2])
    return clamp((0.5 - pos) * 4)


def _atr(ctx):
    v = _need(ctx, "atr14", "atr14_avg")
    if v is None or v[1] <= 0:
        return None
    return clamp((v[0] / v[1] - 1) * 2)


def _pivot(ctx):
    v = _need(ctx, "close", "pivot_r1", "pivot_s1")
    if v is None or v[1] <= v[2]:
        return None
    mid, half = (v[1] + v[2]) / 2, (v[1] - v[2]) / 2
    return clamp((v[0] - mid) / half)


def _ratio_to_average(ctx):
    v = _need(ctx, "value", "value_avg")
    if v is None or v[1] <= 0:
        return None
    return clamp((v[0] / v[1] - 1) * 2)


def _zscore(ctx):
    v = _need(ctx, "value", "value_avg", "value_sd")
    if v is None or v[2] <= 0:
        return None
    return clamp((v[0] - v[1]) / v[2] / 2)


CLASSIFIERS: dict[str, Callable[[dict], float | None]] = {
    "rsi14": _rsi,
    "stoch": _stoch,
    "willr": _willr,
    "macd": _macd,
    "adx": _adx,
    "sma50": _vs_level("sma50"),
    "sma200": _vs_level("sma200", divisor=2.0),
    "bollinger": _bollinger,
    "atr14": _atr,
    "fib618": _vs_level("fib618"),
    "fib50": _vs_level("fib50"),
    "pivot": _pivot,
    "gvz": _ratio_to_average,
    "net_spec": _zscore,
}


def classify(name: str, ctx: dict) -> float | None:
    """State for `name` given a context of raw values, or None if unreadable.

    KeyError on an unknown name is deliberate: a typo in config/weights.yaml
    must fail loudly at fit time rather than produce a feature column that is
    silently absent from a 38-column matrix nobody eyeballs.
    """
    return CLASSIFIERS[name](ctx)


AVG_WINDOW = 50


def bar_states(name: str, bars: list[Bar], timeframe: str) -> list[tuple[str, float]]:
    """Every readable state for `name` over `bars`, stamped at each bar's CLOSE.

    Stamping at the close, not the open, is the no-lookahead guarantee: a
    state derived from a daily bar is not knowable until that day ends.
    """
    rows = ind.compute_all(bars)
    atrs = [r["atr14"] for r in rows]
    atr_avg = ind.sma([a if a is not None else 0.0 for a in atrs], AVG_WINDOW)
    out: list[tuple[str, float]] = []
    for i, ctx in enumerate(rows):
        state = classify(name, {**ctx, "atr14_avg": atr_avg[i]})
        if state is not None:
            out.append((close_ts(bars[i].ts, timeframe), state))
    return out


def series_states(name: str, points: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """States for an external `prices` series: (ts, value) in, (ts, state) out.

    These carry no bar structure, so their timestamp IS their observation
    time — there is no open/close distinction to get wrong.
    """
    values = [v for _, v in points]
    avg = ind.sma(values, AVG_WINDOW)
    sd = ind.stdev(values, AVG_WINDOW)
    out: list[tuple[str, float]] = []
    for i, (ts, v) in enumerate(points):
        state = classify(name, {"value": v, "value_avg": avg[i], "value_sd": sd[i]})
        if state is not None:
            out.append((ts, state))
    return out


def refresh(conn: sqlite3.Connection, weights: dict, symbol: str = "GC") -> int:
    """Recompute the latest state for every configured signal column.

    Only the most recent state per key is written. The fit does not read this
    table — it recomputes history from bars — so this exists purely so the
    panel can render a colour without porting the classifiers to TypeScript,
    which is a duplicate nobody could keep honest.
    """
    written = 0
    for spec in signal_specs(weights):
        for tf in spec.timeframes:
            if spec.source == "bars":
                states = bar_states(spec.name, read_bars(conn, symbol, tf), tf)
            else:
                points = [
                    (r["ts"], r["value"])
                    for r in conn.execute(
                        "SELECT ts, value FROM prices WHERE symbol = ? ORDER BY ts",
                        (spec.symbol,),
                    )
                ]
                states = series_states(spec.name, points)
            if not states:
                continue
            ts, value = states[-1]
            conn.execute(
                "INSERT OR REPLACE INTO signal_states (key, ts, value)"
                " VALUES (?, ?, ?)",
                (f"{spec.name}@{tf}", ts, value),
            )
            written += 1
    conn.commit()
    return written
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `uv run pytest tests/test_signals.py -v`
Expected: PASS

- [ ] **Step 8: Write the failing refresh and CLI tests**

Append to `tests/test_signals.py`:

```python
from jamasp import db
from jamasp.config import load_weights
from jamasp.ingest.bars import store_bars


def test_refresh_writes_one_row_per_readable_column(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    for tf in ("1d", "4h", "1w"):
        store_bars(conn, "GC", tf, _rising(300))
    n = signals.refresh(conn, load_weights(), "GC")
    keys = {r["key"] for r in conn.execute("SELECT key FROM signal_states")}
    assert n == len(keys)
    # 12 bar signals x 3 timeframes; GVZ and net spec have no prices rows here.
    assert "rsi14@1d" in keys and "sma200@4h" in keys
    assert not any(k.startswith("gvz") or k.startswith("net_spec") for k in keys)


def test_refresh_is_idempotent(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    for tf in ("1d", "4h", "1w"):
        store_bars(conn, "GC", tf, _rising(300))
    signals.refresh(conn, load_weights(), "GC")
    before = conn.execute("SELECT COUNT(*) c FROM signal_states").fetchone()["c"]
    signals.refresh(conn, load_weights(), "GC")
    after = conn.execute("SELECT COUNT(*) c FROM signal_states").fetchone()["c"]
    assert before == after


def test_refresh_with_no_bars_writes_nothing_rather_than_raising(tmp_path):
    # A host that has not run the backfill yet must not take the timer down.
    conn = db.connect(tmp_path / "j.db")
    assert signals.refresh(conn, load_weights(), "GC") == 0
```

Append to `tests/test_cli.py`:

```python
def test_signals_refresh_reports_a_count(tmp_path):
    from datetime import datetime, timedelta, timezone

    from jamasp.ingest.bars import TS_FMT, Bar, store_bars

    cfg = _write_configs(tmp_path, "sources: []\n")
    dbp = tmp_path / "j.db"
    conn = db.connect(dbp)
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    bars = [
        Bar((base + timedelta(days=i)).strftime(TS_FMT),
            100.0 + i, 101.0 + i, 99.0 + i, 100.0 + i)
        for i in range(300)
    ]
    for tf in ("1d", "4h", "1w"):
        store_bars(conn, "GC", tf, bars)
    conn.close()

    res = CliRunner().invoke(
        main, ["signals", "refresh", "--db", str(dbp), "--config-dir", str(cfg)])
    assert res.exit_code == 0, res.output
    assert "signal states" in res.output
```

Note: `jamasp signals refresh` reads `config/weights.yaml` from `--config-dir`, so `_write_configs` must also write a weights file there. Extend `_write_configs` to copy the real `config/weights.yaml` into the temporary config dir:

```python
    (cfg / "weights.yaml").write_text(Path("config/weights.yaml").read_text())
```

- [ ] **Step 9: Add the CLI command**

In `jamasp/cli.py`, import `from jamasp import signals as signals_mod` and `from jamasp.config import load_weights` (the latter may already be imported — check line 27 before adding a duplicate), then:

```python
@main.group("signals")
def signals_group():
    """Technical signal states in [-1, +1], positive = bullish for gold."""


@signals_group.command("refresh")
@click.option("--symbol", default="GC", show_default=True)
@db_opt
@cfg_opt
def signals_refresh(symbol, db_path, config_dir):
    """Recompute the latest state for every configured signal column."""
    conn, _, _ = _common(db_path, config_dir)
    weights = load_weights(Path(config_dir) / "weights.yaml")
    n = signals_mod.refresh(conn, weights, symbol)
    click.echo(f"{n} signal states written")
```

- [ ] **Step 10: Run the whole suite and commit**

Run: `uv run pytest -q`
Expected: PASS

Stage `jamasp/signals.py`, `jamasp/db.py`, `jamasp/ingest/bars.py`, `jamasp/cli.py`, `tests/test_signals.py`, `tests/test_bars.py`, `tests/test_db.py`, `tests/test_cli.py` and commit with:

```
feat(signals): indicator states in [-1, +1], positive = bullish for gold

The sign convention is load-bearing and easy to get backwards, so each
classifier is pinned individually rather than trusted to read correctly:
RSI 30 is +1, the lower Bollinger band is +1, and ADX — which measures
strength, not direction — is signed by the regime it is measuring.

signal_states stamps each state at its bar's CLOSE, not its open. A state
derived from a daily bar is not knowable until that day ends; storing the
open would let the panel show it hours early and let the fit train on it.

The fit does not read this table — it recomputes history from bars — so a
refit is reproducible from bars alone and cannot inherit a state written
by an older version of a classifier.
```

---

### Task 6: `jamasp/features.py` — the hourly training matrix

**Files:**
- Create: `jamasp/features.py`
- Create: `tests/test_features.py`

**Interfaces:**
- Consumes: `read_bars`, `close_ts`, `Bar` (Tasks 1–2, 5); `atr` (Task 4); `bar_states`, `series_states` (Task 5); `signal_columns`, `signal_specs`, `themes`, `tier_weights` (Task 3).
- Produces:
  - `@dataclass(frozen=True) class TrainingData: columns: tuple[str, ...]; rows: tuple[str, ...]; X: list[list[float]]; y: list[float]; observations: dict[str, int]`
  - `target_series(conn, symbol: str, horizon_hours: int) -> list[tuple[str, float]]`
  - `column_history(conn, weights, symbol: str) -> dict[str, list[tuple[str, float]]]`
  - `as_of(history: list[tuple[str, float]], ts: str) -> float | None`
  - `build_technical(conn, weights, symbol: str = "GC") -> TrainingData`
  - `build_theme(conn, weights, symbol: str = "GC") -> TrainingData`

**The three things this module has to get right:**

1. **The target.** `y(t) = (close_1h(t + H) - close_1h(t)) / atr14_1d(t)`. Dividing by ATR is what makes rows from a quiet week and a panic week comparable; without it the fit is dominated by whichever regime had the biggest numbers.

2. **No lookahead.** A signal's state enters row `t` only if the bar it came from had already *closed* by `t`. `bar_states` already stamps at the close, so this module compares against the stamp — never against a bar's open, and never against "the most recent bar in the table".

3. **Missing is neutral, and counted.** A column with no reading yet (a weekly SMA200 needs 200 weeks) fills with `0.0`, which is the genuine no-read value on a scale where 0 means "no call". But filling silently would let a column of almost-all zeros collect a coefficient as if it had been measured, so `observations` counts the non-neutral readings per column and the fit refuses to publish a coefficient for a column below `min_observations`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_features.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from jamasp import db, features
from jamasp.config import load_weights, signal_columns, themes
from jamasp.ingest.bars import TS_FMT, Bar, close_ts, store_bars

# Daily bars start a month BEFORE the hourly ones on purpose. The target
# divides by ATR14, which needs fourteen daily bars to warm up, and `as_of`
# refuses to reach forward — so an hourly row dated before ATR's first
# reading has no divisor and is dropped. Overlapping the two series at the
# same start date would silently empty every target in this file.
DAILY_START = "2026-01-01T00:00:00Z"
HOURLY_START = "2026-02-01T00:00:00Z"


def _ts(start, i, seconds):
    base = datetime.strptime(start, TS_FMT).replace(tzinfo=timezone.utc)
    return (base + timedelta(seconds=i * seconds)).strftime(TS_FMT)


def _hourly(n, start=HOURLY_START):
    """n consecutive hourly bars, +1 per hour so a forward return is exact."""
    return [Bar(_ts(start, i, 3600), 100.0 + i, 101.0 + i, 99.0 + i, 100.0 + i)
            for i in range(n)]


def _daily(n, start=DAILY_START):
    """n daily bars spanning exactly 4 with a mid-range close, so ATR14 is 4."""
    return [Bar(_ts(start, i, 86400), 100.0, 102.0, 98.0, 100.0)
            for i in range(n)]


# ---- as_of ------------------------------------------------------------------

def test_as_of_returns_the_latest_value_at_or_before_the_instant():
    hist = [("2026-01-05T00:00:00Z", 1.0), ("2026-01-06T00:00:00Z", 2.0)]
    assert features.as_of(hist, "2026-01-05T12:00:00Z") == 1.0
    assert features.as_of(hist, "2026-01-06T00:00:00Z") == 2.0
    assert features.as_of(hist, "2026-01-07T00:00:00Z") == 2.0


def test_as_of_returns_none_before_the_first_observation():
    # This is the whole no-lookahead guarantee in one function: an instant
    # earlier than anything observed has no value, and must not borrow the
    # first future one.
    hist = [("2026-01-06T00:00:00Z", 2.0)]
    assert features.as_of(hist, "2026-01-05T23:59:59Z") is None


def test_as_of_of_an_empty_history_is_none():
    assert features.as_of([], "2026-01-05T00:00:00Z") is None


# ---- target -----------------------------------------------------------------

def test_target_is_the_forward_return_divided_by_atr(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    # +1 per hour, so the 3-hour forward return is exactly +3, over an ATR of 4.
    store_bars(conn, "GC", "1h", _hourly(48))
    store_bars(conn, "GC", "1d", _daily(40))
    out = dict(features.target_series(conn, "GC", horizon_hours=3))
    assert out[HOURLY_START] == pytest.approx(3.0 / 4.0)


def test_target_drops_hours_with_no_future_close(tmp_path):
    # An exact +H lookup is used rather than "the next close after t+H":
    # inventing a return across a weekend gap would be a fabricated
    # observation, and the cost is only that weekend-adjacent hours drop out.
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1h", _hourly(10))
    store_bars(conn, "GC", "1d", _daily(40))
    stamps = [ts for ts, _ in features.target_series(conn, "GC", horizon_hours=3)]
    # 10 hourly bars, horizon 3 -> the last three have no future close.
    assert len(stamps) == 7
    assert _ts(HOURLY_START, 7, 3600) not in stamps


def test_target_is_empty_when_the_hourly_window_predates_atr(tmp_path):
    # The divisor cannot be borrowed from the future. An hourly series that
    # starts before ATR14's first daily reading yields no rows at all —
    # which is the correct answer, and the reason DAILY_START leads
    # HOURLY_START by a month everywhere else in this file.
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1h", _hourly(48, start=DAILY_START))
    store_bars(conn, "GC", "1d", _daily(40))
    assert features.target_series(conn, "GC", horizon_hours=3) == []


def test_target_is_empty_when_atr_has_not_warmed_up(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1h", _hourly(48))
    store_bars(conn, "GC", "1d", _daily(5))   # far short of ATR14's 14 bars
    assert features.target_series(conn, "GC", horizon_hours=3) == []


# ---- no lookahead -----------------------------------------------------------

def test_a_state_is_not_visible_before_its_bar_closes(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    daily = _daily(60)
    store_bars(conn, "GC", "1d", daily)
    hist = features.column_history(conn, load_weights(), "GC")

    # The earliest instant ANY daily state could legitimately carry is the
    # close of the very first daily bar. A stamp at or before that bar's OPEN
    # would mean the state was readable while the bar was still forming —
    # which is the exact defect this asserts against, and the reason
    # bar_states stamps with close_ts rather than the stored ts.
    earliest = close_ts(daily[0].ts, "1d")
    checked = 0
    for key, points in hist.items():
        if not key.endswith("@1d") or not points:
            continue
        checked += 1
        assert points[0][0] >= earliest, (key, points[0][0], earliest)
        assert points == sorted(points), f"{key} history must be ascending"
    assert checked > 0, "no daily column produced any state — the test proved nothing"


def test_states_are_forward_filled_between_bar_closes():
    # A daily state holds for the 24 hours after its bar closed, then the next
    # one replaces it. Interpolating between them would invent readings.
    hist = [("2026-01-06T00:00:00Z", 0.5), ("2026-01-07T00:00:00Z", -0.5)]
    assert features.as_of(hist, "2026-01-06T00:00:00Z") == 0.5
    assert features.as_of(hist, "2026-01-06T23:00:00Z") == 0.5
    assert features.as_of(hist, "2026-01-07T01:00:00Z") == -0.5


# ---- technical matrix -------------------------------------------------------

def _seed_bars(conn, hours=200):
    store_bars(conn, "GC", "1h", _hourly(hours))
    store_bars(conn, "GC", "4h", _hourly(hours))
    store_bars(conn, "GC", "1d", _daily(60))
    store_bars(conn, "GC", "1w", _daily(60))


def test_technical_matrix_columns_are_the_configured_signal_columns(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    data = features.build_technical(conn, load_weights(), "GC")
    assert data.columns == signal_columns(load_weights())
    assert len(data.X) == len(data.y) == len(data.rows)
    assert all(len(row) == len(data.columns) for row in data.X)


def test_technical_matrix_fills_an_unread_column_with_neutral_and_counts_it(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    weights = load_weights()
    data = features.build_technical(conn, weights, "GC")
    # sma200@1w needs 200 weekly bars; there are 60 here, so it is never
    # read. Its column must be all-neutral AND report zero observations,
    # so the fit can refuse to publish a coefficient for it rather than
    # fitting one to a column of zeros.
    idx = data.columns.index("sma200@1w")
    assert all(row[idx] == 0.0 for row in data.X)
    assert data.observations["sma200@1w"] == 0
    assert data.observations["rsi14@1d"] > 0


def test_technical_matrix_is_empty_without_bars(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    data = features.build_technical(conn, load_weights(), "GC")
    assert data.X == [] and data.y == []


# ---- theme matrix -----------------------------------------------------------

def _score(conn, item_id, published_at, tier, theme):
    conn.execute(
        "INSERT INTO items (id, source, published_at, headline, url, topic, fetched_at)"
        " VALUES (?, 'test', ?, 'h', 'https://x/' || ?, 'gold', ?)",
        (item_id, published_at, item_id, published_at))
    conn.execute(
        "INSERT INTO item_scores (item_id, tier, direction, conviction, theme, scored_at)"
        " VALUES (?, ?, 1, 0.8, ?, ?)",
        (item_id, tier, theme, published_at))
    conn.commit()


def test_theme_exposure_sums_tier_weights_within_the_hour(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    # Two tier-5 stories (100 each) in the same hour, one tier-3 (30) in the
    # next. The timestamps sit inside the hourly grid _seed_bars laid down.
    _score(conn, "a", "2026-02-02T02:10:00Z", 5, "rates_dollar")
    _score(conn, "b", "2026-02-02T02:50:00Z", 5, "rates_dollar")
    _score(conn, "c", "2026-02-02T03:05:00Z", 3, "rates_dollar")
    data = features.build_theme(conn, load_weights(), "GC")
    idx = data.columns.index("rates_dollar")
    by_hour = {ts: row[idx] for ts, row in zip(data.rows, data.X)}
    assert by_hour["2026-02-02T02:00:00Z"] == pytest.approx(200.0)
    assert by_hour["2026-02-02T03:00:00Z"] == pytest.approx(30.0)
    assert by_hour["2026-02-02T04:00:00Z"] == pytest.approx(0.0)


def test_theme_matrix_carries_the_signal_columns_as_controls(tmp_path):
    # Without these the fit credits news with moves the tape was already
    # making. They are the entire reason Fit B is not just Fit A with
    # different columns.
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    _score(conn, "a", "2026-02-02T02:10:00Z", 5, "rates_dollar")
    weights = load_weights()
    data = features.build_theme(conn, weights, "GC")
    assert data.columns[: len(themes(weights))] == themes(weights)
    assert data.columns[len(themes(weights)):] == signal_columns(weights)


def test_theme_matrix_starts_at_the_first_scored_item(tmp_path):
    # Hours before any story was scored carry a genuine zero for every theme,
    # but they are not observations of "no news moved gold" — they are hours
    # in which nothing was being classified at all.
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    _score(conn, "a", "2026-02-02T02:10:00Z", 5, "rates_dollar")
    data = features.build_theme(conn, load_weights(), "GC")
    assert data.rows[0] >= "2026-02-02T02:00:00Z"


def test_theme_matrix_is_empty_with_no_scored_items(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    data = features.build_theme(conn, load_weights(), "GC")
    assert data.X == [] and data.y == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_features.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.features'`

- [ ] **Step 3: Implement `jamasp/features.py`**

```python
"""The hourly training matrix: one row per hour, features and target.

Three things this module exists to get right.

The TARGET is the forward return over H hours divided by daily ATR14, which
is what makes a row from a quiet week and a row from a panic week comparable.
Without the divisor the fit is dominated by whichever regime had the biggest
numbers rather than by which features predicted anything.

NO LOOKAHEAD: a signal's state enters row t only if the bar it came from had
already CLOSED by t. jamasp/signals.py stamps every state at its bar's close
precisely so this module can compare against that stamp — never against a
bar's open, and never against "the latest row in the table".

MISSING IS NEUTRAL, AND COUNTED: a column with no reading yet fills with 0.0,
which is the genuine no-call value on this scale. Filling silently would let
a column of almost-all zeros collect a coefficient as if it had been
measured, so `observations` counts the non-neutral readings and the fit
refuses to publish a coefficient below its min_observations threshold.
"""
from __future__ import annotations

import bisect
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from jamasp import indicators as ind
from jamasp import signals as sig
from jamasp.config import signal_columns, signal_specs, themes, tier_weights
from jamasp.ingest.bars import TS_FMT, close_ts, read_bars

NEUTRAL = 0.0


@dataclass(frozen=True)
class TrainingData:
    columns: tuple[str, ...]
    rows: tuple[str, ...]
    X: list[list[float]]
    y: list[float]
    observations: dict[str, int]


def _shift(ts: str, seconds: int) -> str:
    dt = datetime.strptime(ts, TS_FMT).replace(tzinfo=timezone.utc)
    return (dt + timedelta(seconds=seconds)).strftime(TS_FMT)


def as_of(history: list[tuple[str, float]], ts: str) -> float | None:
    """The latest value observed at or before `ts`, or None if there is none.

    This is the no-lookahead guarantee in one function: an instant earlier
    than anything observed has no value and must not borrow the first future
    one. History must be ascending by timestamp.
    """
    i = bisect.bisect_right([h[0] for h in history], ts)
    return history[i - 1][1] if i else None


def target_series(
    conn: sqlite3.Connection, symbol: str, horizon_hours: int
) -> list[tuple[str, float]]:
    """(hour, forward return / ATR14) for every hour that has both."""
    hourly = read_bars(conn, symbol, "1h")
    daily = read_bars(conn, symbol, "1d")
    if not hourly or not daily:
        return []

    atrs = ind.atr(daily, 14)
    atr_hist = [
        (close_ts(daily[i].ts, "1d"), atrs[i])
        for i in range(len(daily))
        if atrs[i] is not None
    ]
    closes = {b.ts: b.close for b in hourly}

    out: list[tuple[str, float]] = []
    for b in hourly:
        future = closes.get(_shift(b.ts, horizon_hours * 3600))
        if future is None:
            continue  # exact +H match only; see the module docstring
        a = as_of(atr_hist, b.ts)
        if a is None or a <= 0:
            continue
        out.append((b.ts, (future - b.close) / a))
    return out


def column_history(
    conn: sqlite3.Connection, weights: dict, symbol: str
) -> dict[str, list[tuple[str, float]]]:
    """Every signal column's full history, recomputed from bars and prices.

    Recomputed rather than read from `signal_states`: a refit must be
    reproducible from bars alone, and must never inherit states written by an
    older version of a classifier.
    """
    hist: dict[str, list[tuple[str, float]]] = {}
    for spec in signal_specs(weights):
        for tf in spec.timeframes:
            key = f"{spec.name}@{tf}"
            if spec.source == "bars":
                hist[key] = sig.bar_states(spec.name, read_bars(conn, symbol, tf), tf)
            else:
                points = [
                    (r["ts"], r["value"])
                    for r in conn.execute(
                        "SELECT ts, value FROM prices WHERE symbol = ? ORDER BY ts",
                        (spec.symbol,),
                    )
                ]
                hist[key] = sig.series_states(spec.name, points)
    return hist


def _feature_block(
    hist: dict[str, list[tuple[str, float]]], columns: tuple[str, ...], rows: list[str]
) -> tuple[list[list[float]], dict[str, int]]:
    block = [[NEUTRAL] * len(columns) for _ in rows]
    observations = {c: 0 for c in columns}
    for j, col in enumerate(columns):
        points = hist.get(col, [])
        for i, ts in enumerate(rows):
            v = as_of(points, ts)
            if v is not None:
                block[i][j] = v
                observations[col] += 1
    return block, observations


def build_technical(
    conn: sqlite3.Connection, weights: dict, symbol: str = "GC"
) -> TrainingData:
    """Fit A's matrix: all bar history, signal states only."""
    cfg = weights["fit"]
    target = target_series(conn, symbol, cfg["horizon_hours"])
    if not target:
        return TrainingData((), (), [], [], {})

    columns = signal_columns(weights)
    rows = [ts for ts, _ in target]
    X, observations = _feature_block(column_history(conn, weights, symbol), columns, rows)
    return TrainingData(columns, tuple(rows), X, [v for _, v in target], observations)


def _theme_exposure(
    conn: sqlite3.Connection, weights: dict
) -> tuple[dict[tuple[str, str], float], str | None]:
    """(hour, theme) -> summed tier weight, and the first scored hour."""
    tw = tier_weights(weights)
    slots = set(themes(weights))
    exposure: dict[tuple[str, str], float] = {}
    first: str | None = None
    for r in conn.execute(
        "SELECT i.published_at AS ts, s.tier AS tier, s.theme AS theme"
        "  FROM item_scores s JOIN items i ON i.id = s.item_id"
        " ORDER BY i.published_at"
    ):
        # Truncate to the hour the story was published in. Each item
        # contributes to exactly one row, and the target for that row is the
        # return over (t, t+H] — so an item never influences a window that
        # closed before it existed.
        hour = r["ts"][:13] + ":00:00Z"
        theme = r["theme"] if r["theme"] in slots else "other"
        exposure[(hour, theme)] = exposure.get((hour, theme), 0.0) + tw.get(r["tier"], 0.0)
        if first is None or hour < first:
            first = hour
    return exposure, first


def build_theme(
    conn: sqlite3.Connection, weights: dict, symbol: str = "GC"
) -> TrainingData:
    """Fit B's matrix: theme exposures PLUS the signal states as controls.

    The controls are the entire reason this is not Fit A with different
    columns. Without them a theme is credited with whatever move the tape was
    already making at the moment its stories happened to land.

    Rows start at the first scored hour. Earlier hours carry a genuine zero
    for every theme, but they are not observations of "no news moved gold" —
    they are hours in which nothing was being classified at all.
    """
    cfg = weights["fit"]
    exposure, first_scored = _theme_exposure(conn, weights)
    if first_scored is None:
        return TrainingData((), (), [], [], {})

    target = [
        (ts, v)
        for ts, v in target_series(conn, symbol, cfg["horizon_hours"])
        if ts >= first_scored
    ]
    if not target:
        return TrainingData((), (), [], [], {})

    theme_slots = themes(weights)
    sig_cols = signal_columns(weights)
    columns = theme_slots + sig_cols
    rows = [ts for ts, _ in target]

    controls, observations = _feature_block(
        column_history(conn, weights, symbol), sig_cols, rows)

    X: list[list[float]] = []
    theme_obs = {t: 0 for t in theme_slots}
    for i, ts in enumerate(rows):
        head = []
        for t in theme_slots:
            v = exposure.get((ts, t), 0.0)
            if v:
                theme_obs[t] += 1
            head.append(v)
        X.append(head + controls[i])

    return TrainingData(
        columns, tuple(rows), X, [v for _, v in target], {**theme_obs, **observations})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_features.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

Stage `jamasp/features.py` and `tests/test_features.py` and commit with:

```
feat(features): the hourly training matrix

The target divides the forward return by daily ATR14, which is what makes a
row from a quiet week and a row from a panic week comparable — without it
the fit is dominated by whichever regime had the biggest numbers.

No lookahead: a state enters row t only if its bar had already CLOSED by t.
as_of() returns None before the first observation rather than borrowing the
first future one, and that is the guarantee in one function.

Missing is neutral AND counted. A column with no reading fills with 0.0,
which is the genuine no-call value on this scale — but filling silently
would let a column of almost-all zeros collect a coefficient as if it had
been measured, so observations counts the non-neutral readings.

Theme columns recompute from bars rather than reading signal_states, so a
refit is reproducible from bars alone and cannot inherit a state written by
an older classifier.
```

---

### Task 7: `jamasp/fit.py`, the ridge, and Fit A

**Files:**
- Create: `jamasp/fit.py`
- Create: `tests/test_fit.py`
- Modify: `pyproject.toml` (add `numpy>=2.0`)
- Modify: `jamasp/db.py` (add `weight_fits`)
- Modify: `jamasp/cli.py` (add the `weights` group and `fit`)
- Modify: `tests/test_db.py`, `tests/test_cli.py`

**Interfaces:**
- Consumes: `TrainingData`, `build_technical` (Task 6); `fit_config`, `active_pins`, `signal_columns` (Task 3).
- Produces:
  - `@dataclass(frozen=True) class Coefficient: key: str; beta: float; se: float; multiplier: float; observations: int; fitted: bool`
  - `@dataclass(frozen=True) class FitResult: name: str; n: int; horizon_hours: int; ridge_alpha: float; coefficients: list[Coefficient]; flags: list[str]`
  - `ridge(X, y, alpha) -> tuple[list[float], list[float]]` — (betas, standard errors)
  - `to_multipliers(betas, lo, hi) -> tuple[list[float], list[str]]`
  - `run_fit(name, data, cfg, pins, report_columns=None) -> FitResult | None`
  - `write_results(conn, path, results: list[FitResult], fitted_at: str) -> None`
  - `fit_all(conn, weights, symbol="GC", today=None) -> list[FitResult]`
  - CLI: `jamasp weights fit [--symbol GC] [--out state/weights.json]`

**Why numpy.** A hand-rolled solve is about sixty lines and runs in five to fifteen seconds — acceptable on both counts. It is rejected because numerics a reader must *audit* are worse than numerics a reader *recognises*: `np.linalg.solve` is a line anyone can check against a textbook, and a hand-rolled Gaussian elimination is a line only its author can.

**The normalisation, precisely.** `m = β / β̄` where **β̄ is the mean of the strictly positive coefficients**. Before clamping, the positive multipliers therefore average exactly 1.0. Negative coefficients do not enter β̄ — they clamp to the floor and raise a flag, because a negative coefficient means items scored *bullish* were followed by gold going *down*, which is evidence the **direction scoring** is wrong for that theme, not that the theme should shrink. Taking `abs()` would bury the single most useful thing the regression can report. With no positive coefficients at all, every multiplier is 1.0 and a `degenerate_mean` flag says so.

- [ ] **Step 1: Add numpy and the `weight_fits` table**

In `pyproject.toml`, add to `dependencies`:

```toml
    "numpy>=2.0",
```

Run: `uv sync`

In `jamasp/db.py`, append to `SCHEMA`:

```sql
-- Every fitted coefficient from every run, so a multiplier's drift over time
-- is inspectable. state/weights.json holds only the current fit; this is the
-- trajectory, and it is the difference between "rates_dollar is 1.8" and
-- "rates_dollar has climbed from 1.1 to 1.8 over six weeks".
CREATE TABLE IF NOT EXISTS weight_fits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    fitted_at  TEXT NOT NULL,
    fit        TEXT NOT NULL,   -- 'technical' | 'theme'
    key        TEXT NOT NULL,
    beta       REAL NOT NULL,
    se         REAL NOT NULL,
    multiplier REAL NOT NULL,
    n          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_weight_fits_key ON weight_fits(fit, key, fitted_at);
```

Add to `tests/test_db.py`:

```python
def test_weight_fits_table_exists(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(weight_fits)")}
    assert cols == {"id", "fitted_at", "fit", "key", "beta", "se", "multiplier", "n"}
```

Run: `uv run pytest tests/test_db.py -v -k weight_fits`
Expected: PASS

- [ ] **Step 2: Write the failing fit tests**

Create `tests/test_fit.py`:

```python
import json
import random

import pytest

from jamasp import db, fit
from jamasp.config import load_weights


def _synthetic(n, coefs, noise=0.0, seed=20260820):
    """Rows whose target is a known linear combination of the columns.

    A seeded RNG rather than a modular pattern like `(i + j*7) % 11`: cyclic
    patterns make the columns near-perfect shifts of one another, and ridge
    splits an effect across collinear predictors — so the recovered ratios
    would reflect the collinearity rather than the coefficients this is
    supposed to recover. Seeded means deterministic; uncorrelated means the
    assertions test what they claim to.
    """
    rng = random.Random(seed)
    X, y = [], []
    for _ in range(n):
        row = [rng.uniform(-1.0, 1.0) for _ in coefs]
        X.append(row)
        y.append(sum(c * v for c, v in zip(coefs, row))
                 + noise * rng.uniform(-1.0, 1.0))
    return X, y


# ---- the ridge itself -------------------------------------------------------

def test_ridge_recovers_known_coefficients():
    # Ridge shrinks, so the recovered ratios matter more than the magnitudes:
    # a column with three times another's true effect must come out roughly
    # three times larger.
    X, y = _synthetic(400, [3.0, 1.0, 0.0])
    betas, _ = fit.ridge(X, y, alpha=0.1)
    assert betas[0] > betas[1] > 0
    assert betas[0] / betas[1] == pytest.approx(3.0, rel=0.25)
    assert abs(betas[2]) < 0.1


def test_ridge_shrinks_more_at_higher_alpha():
    X, y = _synthetic(400, [3.0, 1.0, 0.0])
    weak, _ = fit.ridge(X, y, alpha=0.1)
    strong, _ = fit.ridge(X, y, alpha=1000.0)
    assert abs(strong[0]) < abs(weak[0])


def test_ridge_gives_a_zero_variance_column_a_zero_coefficient():
    # A constant column carries no information. Standardising it would divide
    # by zero; the fit must hand back 0.0, not a NaN that poisons every
    # downstream multiplier.
    X, y = _synthetic(300, [2.0, 1.0])
    for row in X:
        row.append(5.0)
    betas, ses = fit.ridge(X, y, alpha=1.0)
    assert betas[2] == 0.0
    assert ses[2] == 0.0


def test_ridge_standard_errors_are_positive_and_finite():
    X, y = _synthetic(400, [3.0, 1.0, 0.0], noise=0.5)
    _, ses = fit.ridge(X, y, alpha=1.0)
    assert all(s > 0 for s in ses[:3])


def test_ridge_standard_errors_shrink_with_more_rows():
    Xs, ys = _synthetic(120, [2.0, 1.0], noise=0.5)
    Xl, yl = _synthetic(1200, [2.0, 1.0], noise=0.5)
    _, se_small = fit.ridge(Xs, ys, alpha=1.0)
    _, se_large = fit.ridge(Xl, yl, alpha=1.0)
    assert se_large[0] < se_small[0]


# ---- multipliers ------------------------------------------------------------

def test_positive_multipliers_average_one_before_clamping():
    ms, flags = fit.to_multipliers([1.0, 2.0, 3.0], lo=0.01, hi=100.0)
    assert sum(ms) / len(ms) == pytest.approx(1.0)
    assert flags == []


def test_multipliers_clamp_to_the_configured_band():
    # beta_bar here is mean([1]*9 + [100]) = 10.9, so the outlier's raw
    # multiplier is 9.17 (clamps to the ceiling) and each 1.0 gives 0.092
    # (clamps to the floor). Note that clamping breaks the mean-1.0 property
    # — deliberately: a bounded area channel matters more than an exact mean.
    ms, _ = fit.to_multipliers([1.0] * 9 + [100.0], lo=0.25, hi=3.0)
    assert ms[-1] == 3.0
    assert ms[0] == 0.25
    assert all(0.25 <= m <= 3.0 for m in ms)


def test_a_negative_coefficient_clamps_to_the_floor_and_flags():
    # A negative coefficient means items scored bullish were followed by gold
    # going DOWN — evidence the direction scoring is wrong, not that the
    # theme should shrink. abs() would bury the single most useful thing the
    # regression can report.
    ms, flags = fit.to_multipliers([2.0, -1.0], lo=0.25, hi=3.0)
    assert ms[1] == 0.25
    assert any("negative" in f for f in flags)


def test_negative_coefficients_do_not_enter_the_normalising_mean():
    # Otherwise one bad column drags the mean toward zero and inflates every
    # other multiplier — or flips their signs when the mean goes negative.
    with_neg, _ = fit.to_multipliers([1.0, 3.0, -8.0], lo=0.01, hi=100.0)
    without, _ = fit.to_multipliers([1.0, 3.0], lo=0.01, hi=100.0)
    assert with_neg[:2] == pytest.approx(without)


def test_all_negative_coefficients_yield_neutral_multipliers_and_a_flag():
    ms, flags = fit.to_multipliers([-1.0, -2.0], lo=0.25, hi=3.0)
    assert ms == [1.0, 1.0]
    assert "degenerate_mean" in flags


# ---- run_fit ----------------------------------------------------------------

def _data(columns, X, y, observations=None):
    from jamasp.features import TrainingData

    obs = observations or {c: len(X) for c in columns}
    return TrainingData(tuple(columns), tuple(str(i) for i in range(len(X))),
                        X, y, obs)


CFG = {"horizon_hours": 24, "ridge_alpha": 1.0, "min_rows": 200,
       "multiplier_min": 0.25, "multiplier_max": 3.0, "min_observations": 50}


def test_run_fit_refuses_below_min_rows():
    X, y = _synthetic(10, [1.0, 1.0])
    assert fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {}) is None


def test_run_fit_marks_an_under_observed_column_unfitted():
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y, {"a": 400, "b": 3}),
                      CFG, {})
    by_key = {c.key: c for c in res.coefficients}
    assert by_key["a"].fitted is True
    # 3 observations is not a measurement. Publishing a coefficient for it
    # would render a confidently-sized tile built on nothing.
    assert by_key["b"].fitted is False
    assert by_key["b"].multiplier == 1.0


def test_run_fit_applies_a_pin_over_the_fitted_value():
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {"a": 2.5})
    by_key = {c.key: c for c in res.coefficients}
    assert by_key["a"].multiplier == 2.5
    assert by_key["b"].multiplier != 2.5


def test_run_fit_reports_only_the_requested_columns():
    # Fit B fits over themes AND controls but reports only the themes: the
    # control coefficients exist to absorb the tape, not to be published.
    X, y = _synthetic(400, [3.0, 1.0, 0.5])
    res = fit.run_fit("theme", _data(["t1", "t2", "ctrl"], X, y), CFG, {},
                      report_columns=("t1", "t2"))
    assert [c.key for c in res.coefficients] == ["t1", "t2"]


def test_run_fit_records_n_and_the_hyperparameters():
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {})
    assert res.n == 400
    assert res.horizon_hours == 24 and res.ridge_alpha == 1.0


# ---- persistence ------------------------------------------------------------

def test_write_results_produces_readable_json_and_db_rows(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {})
    out = tmp_path / "weights.json"
    fit.write_results(conn, out, [res], "2026-08-20T04:17:00Z")

    doc = json.loads(out.read_text())
    assert doc["fitted_at"] == "2026-08-20T04:17:00Z"
    assert doc["fits"]["technical"]["n"] == 400
    entry = doc["fits"]["technical"]["coefficients"]["a"]
    assert set(entry) == {"beta", "se", "multiplier", "observations", "fitted"}

    rows = conn.execute("SELECT fit, key, multiplier FROM weight_fits").fetchall()
    assert {r["key"] for r in rows} == {"a", "b"}


def test_write_results_appends_a_second_fit_rather_than_replacing(tmp_path):
    # weight_fits is the trajectory. Overwriting would leave the panel able to
    # show a number but never how it got there.
    conn = db.connect(tmp_path / "j.db")
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {})
    fit.write_results(conn, tmp_path / "w.json", [res], "2026-08-20T04:17:00Z")
    fit.write_results(conn, tmp_path / "w.json", [res], "2026-08-21T04:17:00Z")
    stamps = {r["fitted_at"] for r in conn.execute("SELECT fitted_at FROM weight_fits")}
    assert stamps == {"2026-08-20T04:17:00Z", "2026-08-21T04:17:00Z"}


def test_write_results_is_atomic(tmp_path):
    # The panel reads this file on every request. A half-written file would
    # be a JSON parse error on a live page, so the write goes via a temp file
    # and a rename.
    conn = db.connect(tmp_path / "j.db")
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {})
    out = tmp_path / "weights.json"
    fit.write_results(conn, out, [res], "2026-08-20T04:17:00Z")
    assert json.loads(out.read_text())["fits"]["technical"]["n"] == 400
    assert not list(tmp_path.glob("*.tmp"))
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_fit.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.fit'`

- [ ] **Step 4: Implement `jamasp/fit.py`**

```python
"""Ridge fits over the hourly matrix, and the multipliers they produce.

numpy rather than a hand-rolled solve. The hand-rolled version is about sixty
lines and runs in five to fifteen seconds, both acceptable — it is rejected
because numerics a reader must AUDIT are worse than numerics a reader
RECOGNISES. np.linalg.solve is a line anyone can check against a textbook.

The normalisation is `m = beta / beta_bar` where beta_bar is the mean of the
strictly POSITIVE coefficients, so before clamping the positive multipliers
average exactly 1.0. Negative coefficients stay out of that mean and clamp to
the floor with a flag: a negative coefficient means items scored bullish were
followed by gold going down, which is evidence the DIRECTION SCORING is wrong
for that column, not that the column should shrink. abs() would bury the
single most useful thing the regression can report.

One caveat, recorded rather than hidden: at H = 24h consecutive rows have
overlapping target windows, which autocorrelates residuals. That inflates
apparent significance without biasing the coefficients — which is why this
module reports standard errors and sample counts and never a p-value. A
p-value here would be quietly wrong in a way that looks authoritative.
"""
from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from jamasp.config import active_pins, fit_config, signal_columns, themes
from jamasp.db import utcnow
from jamasp.features import TrainingData, build_technical


@dataclass(frozen=True)
class Coefficient:
    key: str
    beta: float
    se: float
    multiplier: float
    observations: int
    fitted: bool


@dataclass(frozen=True)
class FitResult:
    name: str
    n: int
    horizon_hours: int
    ridge_alpha: float
    coefficients: list[Coefficient]
    flags: list[str]


def ridge(X: list[list[float]], y: list[float], alpha: float
          ) -> tuple[list[float], list[float]]:
    """Standardised ridge. Returns (betas, standard errors).

    Columns are z-scored so coefficients are comparable across features that
    live on different scales — which is the entire point, since the
    multipliers are ratios between them. A zero-variance column would divide
    by zero when standardising; it carries no information, so it is zeroed
    out rather than allowed to produce a NaN that poisons every other
    multiplier through the normalising mean.
    """
    A = np.asarray(X, dtype=float)
    b = np.asarray(y, dtype=float)
    n, p = A.shape

    sd = A.std(axis=0)
    live = sd > 1e-12
    betas = np.zeros(p)
    ses = np.zeros(p)
    if not live.any():
        return betas.tolist(), ses.tolist()

    Z = (A[:, live] - A[:, live].mean(axis=0)) / sd[live]
    yc = b - b.mean()

    gram = Z.T @ Z
    reg = gram + alpha * np.eye(Z.shape[1])
    beta_live = np.linalg.solve(reg, Z.T @ yc)

    resid = yc - Z @ beta_live
    dof = max(1, n - Z.shape[1])
    sigma2 = float(resid @ resid) / dof
    # Ridge covariance: sigma^2 * (Z'Z + aI)^-1 Z'Z (Z'Z + aI)^-1. The plain
    # OLS form would understate the error at any alpha above zero.
    inv = np.linalg.inv(reg)
    cov = sigma2 * inv @ gram @ inv
    se_live = np.sqrt(np.clip(np.diag(cov), 0.0, None))

    betas[live] = beta_live
    ses[live] = se_live
    return betas.tolist(), ses.tolist()


def to_multipliers(betas: list[float], lo: float, hi: float
                   ) -> tuple[list[float], list[str]]:
    """Coefficients -> clamped multipliers, plus any flags raised."""
    flags: list[str] = []
    positives = [b for b in betas if b > 0]
    if not positives:
        # Nothing to normalise against. Neutral multipliers are the honest
        # answer; a map of equal tiles says "no read yet" rather than
        # inventing an ordering out of noise.
        return [1.0] * len(betas), ["degenerate_mean"]

    bar = sum(positives) / len(positives)
    out: list[float] = []
    for i, b in enumerate(betas):
        if b < 0:
            flags.append(f"negative:{i}")
            out.append(lo)
        else:
            out.append(max(lo, min(hi, b / bar)))
    return out, flags


def run_fit(name: str, data: TrainingData, cfg: dict, pins: dict[str, float],
            report_columns: tuple[str, ...] | None = None) -> FitResult | None:
    """One ridge fit. None when there are not enough rows to justify one."""
    if len(data.y) < cfg["min_rows"]:
        return None

    betas, ses = ridge(data.X, data.y, cfg["ridge_alpha"])
    multipliers, flags = to_multipliers(
        betas, cfg["multiplier_min"], cfg["multiplier_max"])
    # Re-label the positional flags to_multipliers emitted with real keys.
    flags = [
        f"negative:{data.columns[int(f.split(':')[1])]}" if f.startswith("negative:") else f
        for f in flags
    ]

    keep = report_columns if report_columns is not None else data.columns
    coefficients: list[Coefficient] = []
    for col in keep:
        # A requested column absent from the matrix is skipped rather than
        # raising: callers ask for a whole taxonomy (every theme slot) and a
        # matrix built from a database with no stories in one of them
        # legitimately has no column for it.
        if col not in data.columns:
            continue
        j = data.columns.index(col)
        obs = data.observations.get(col, 0)
        fitted = obs >= cfg["min_observations"]
        # An under-observed column renders neutral and dashed rather than
        # publishing a coefficient estimated from a handful of rows.
        m = multipliers[j] if fitted else 1.0
        if col in pins:
            m = pins[col]
        coefficients.append(Coefficient(
            key=col, beta=betas[j], se=ses[j], multiplier=m,
            observations=obs, fitted=fitted))

    return FitResult(name=name, n=len(data.y), horizon_hours=cfg["horizon_hours"],
                     ridge_alpha=cfg["ridge_alpha"], coefficients=coefficients,
                     flags=flags)


def write_results(conn: sqlite3.Connection, path: Path,
                  results: list[FitResult], fitted_at: str) -> None:
    """Publish the current fit to JSON and append it to the trajectory table.

    The JSON write goes via a temp file and a rename because the panel reads
    it on every request: a half-written file would surface as a JSON parse
    error on a live page.
    """
    doc = {"fitted_at": fitted_at, "fits": {}}
    for r in results:
        doc["fits"][r.name] = {
            "n": r.n,
            "horizon_hours": r.horizon_hours,
            "ridge_alpha": r.ridge_alpha,
            "flags": r.flags,
            "coefficients": {
                c.key: {"beta": c.beta, "se": c.se, "multiplier": c.multiplier,
                        "observations": c.observations, "fitted": c.fitted}
                for c in r.coefficients
            },
        }
        conn.executemany(
            "INSERT INTO weight_fits (fitted_at, fit, key, beta, se, multiplier, n)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(fitted_at, r.name, c.key, c.beta, c.se, c.multiplier, r.n)
             for c in r.coefficients],
        )
    conn.commit()

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=1))
    os.replace(tmp, path)


def fit_all(conn: sqlite3.Connection, weights: dict, symbol: str = "GC",
            today: str | None = None) -> list[FitResult]:
    """Every fit this deployment can currently support.

    A full refit from history each time, not an incremental nudge:
    idempotent, reproducible, no drift.
    """
    cfg = fit_config(weights)
    pins = active_pins(weights, (today or utcnow())[:10])
    results: list[FitResult] = []
    a = run_fit("technical", build_technical(conn, weights, symbol), cfg, pins)
    if a is not None:
        results.append(a)
    return results
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_fit.py -v`
Expected: PASS

- [ ] **Step 6: Add the CLI command**

In `jamasp/cli.py`, import `from jamasp import fit as fit_mod`, then:

```python
@main.group("weights")
def weights_group():
    """Learned map multipliers: the daily ridge fit."""


@weights_group.command("fit")
@click.option("--symbol", default="GC", show_default=True)
@click.option("--out", default="state/weights.json", show_default=True)
@db_opt
@cfg_opt
def weights_fit(symbol, out, db_path, config_dir):
    """Refit every multiplier from history. Deterministic; no agent run."""
    conn, _, _ = _common(db_path, config_dir)
    weights = load_weights(Path(config_dir) / "weights.yaml")
    results = fit_mod.fit_all(conn, weights, symbol)
    if not results:
        click.echo("weights fit: no fit had enough rows yet")
        return
    fit_mod.write_results(conn, Path(out), results, db_mod.utcnow())
    for r in results:
        unfitted = sum(1 for c in r.coefficients if not c.fitted)
        click.echo(
            f"{r.name}: n={r.n} {len(r.coefficients)} columns"
            f" ({unfitted} unfitted) flags={len(r.flags)}")
```

Append to `tests/test_cli.py`:

```python
def test_weights_fit_reports_when_there_is_not_enough_history(tmp_path):
    cfg = _write_configs(tmp_path, "sources: []\n")
    res = CliRunner().invoke(main, [
        "weights", "fit", "--db", str(tmp_path / "j.db"),
        "--config-dir", str(cfg), "--out", str(tmp_path / "w.json")])
    assert res.exit_code == 0, res.output
    assert "not enough rows" in res.output
    # No file, rather than an empty one: a weights.json full of nothing is
    # indistinguishable to the panel from a fit that produced neutral weights.
    assert not (tmp_path / "w.json").exists()
```

- [ ] **Step 7: Run the whole suite**

Run: `uv run pytest -q`
Expected: PASS

- [ ] **Step 8: Commit**

Stage `jamasp/fit.py`, `pyproject.toml`, `uv.lock`, `jamasp/db.py`, `jamasp/cli.py`, `tests/test_fit.py`, `tests/test_db.py`, `tests/test_cli.py` and commit with:

```
feat(fit): ridge fit and learned multipliers (Fit A)

numpy rather than a hand-rolled solve. The hand-rolled version is ~60 lines
and 5-15s, both acceptable — it is rejected because numerics a reader must
audit are worse than numerics a reader recognises.

m = beta/beta_bar with beta_bar the mean of the strictly POSITIVE
coefficients, so positive multipliers average exactly 1.0 before clamping.
Negatives stay out of that mean and clamp to the floor with a flag: a
negative coefficient is evidence the direction scoring is wrong for that
column, not that the column should shrink, and abs() would bury it.

Standard errors use the ridge covariance, not the OLS form, which would
understate the error at any alpha above zero. No p-values: at H=24h
consecutive rows share target windows, so residuals autocorrelate and a
p-value would be quietly wrong in a way that looks authoritative.
```

---

### Task 8: Fit B — theme weights with technical controls — and the daily timer

**Files:**
- Modify: `jamasp/fit.py` (`fit_all` gains Fit B)
- Modify: `tests/test_fit.py`
- Create: `ops/systemd/jamasp-weights.service`
- Create: `ops/systemd/jamasp-weights.timer`
- Modify: `.claude/skills/deploy/SKILL.md`
- Modify: `CLAUDE.md` (toolbox table + deployment paragraph)

**Interfaces:**
- Consumes: `build_theme` (Task 6), `run_fit` (Task 7), `themes` (Task 3).
- Produces: `fit_all` returns up to two `FitResult`s, named `"technical"` and `"theme"`.

**Why the controls are the point.** Fit B fits over theme exposures **and** the 38 signal columns, then reports only the themes. The signal coefficients are discarded — they exist so a news effect is not credited with a move the tape was already making. The test in Step 1 is the one a reviewer should read first: if it does not discriminate, the controls are decorative.

- [ ] **Step 1: Write the failing control test**

Append to `tests/test_fit.py`:

```python
def _tape_driven(n, seed=7):
    """News that arrives when the tape is already strong, and a target that
    is entirely explained by the tape.

    The exposure is CORRELATED with the technical state, not determined by
    it. A deterministic `exposure = 100 if s > 0` makes the two columns
    perfectly collinear, and ridge splits an effect across collinear
    predictors rather than assigning it — so the controlled coefficient
    would stay large and the test would fail for a reason that has nothing
    to do with whether the controls work.
    """
    rng = random.Random(seed)
    X_theme, X_ctrl, y = [], [], []
    for _ in range(n):
        s = rng.uniform(-1.0, 1.0)                 # the technical state
        # Stories land more often on a strong tape, but not always.
        X_theme.append(100.0 if s + rng.gauss(0, 0.6) > 0 else 0.0)
        X_ctrl.append(s)
        y.append(2.0 * s)                          # the move is ALL tape
    return X_theme, X_ctrl, y


def test_controls_strip_a_theme_effect_the_tape_already_explains():
    # This is the whole point of Fit B. If it does not discriminate, the
    # controls are decorative and news is credited with moves the tape was
    # already making.
    theme, ctrl, y = _tape_driven(600)

    naive = fit.run_fit(
        "theme", _data(["rates_dollar"], [[t] for t in theme], y),
        CFG, {}, report_columns=("rates_dollar",))
    controlled = fit.run_fit(
        "theme", _data(["rates_dollar", "sma50@1d"],
                       [[t, c] for t, c in zip(theme, ctrl)], y),
        CFG, {}, report_columns=("rates_dollar",))

    naive_beta = abs(naive.coefficients[0].beta)
    controlled_beta = abs(controlled.coefficients[0].beta)
    assert naive_beta > 0.1, "the uncontrolled fit should see a large theme effect"
    assert controlled_beta < 0.25 * naive_beta, (naive_beta, controlled_beta)


def test_fit_all_runs_both_fits_when_both_have_rows(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    X, y = _synthetic(400, [3.0, 1.0])
    # Patch the names bound INSIDE jamasp.fit. fit.py does
    # `from jamasp.features import build_technical`, so patching
    # jamasp.features.build_technical would rebind a name fit.py no longer
    # reads — a patch that silently does nothing.
    monkeypatch.setattr(fit, "build_technical",
                        lambda *a, **k: _data(["rsi14@1d", "sma50@1d"], X, y))
    monkeypatch.setattr(fit, "build_theme",
                        lambda *a, **k: _data(["rates_dollar", "rsi14@1d"], X, y))

    results = fit.fit_all(conn, load_weights(), "GC", today="2026-08-20")
    assert [r.name for r in results] == ["technical", "theme"]


def test_fit_b_reports_themes_only_never_its_controls(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    X, y = _synthetic(400, [3.0, 1.0])
    monkeypatch.setattr(fit, "build_technical", lambda *a, **k: _data([], [], []))
    monkeypatch.setattr(
        fit, "build_theme",
        lambda *a, **k: _data(["rates_dollar", "rsi14@1d"], X, y))

    results = fit.fit_all(conn, load_weights(), "GC", today="2026-08-20")
    theme_fit = next(r for r in results if r.name == "theme")
    keys = [c.key for c in theme_fit.coefficients]
    assert "rates_dollar" in keys
    # The control coefficients absorb the tape; publishing them here would
    # give the fundamental map a second, contradictory set of technical
    # weights alongside Fit A's.
    assert "rsi14@1d" not in keys
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_fit.py -v -k "controls or fit_all or fit_b"`
Expected: FAIL — `fit_all` runs only the technical fit.

- [ ] **Step 3: Extend `fit_all`**

Replace `fit_all` in `jamasp/fit.py` with:

```python
def fit_all(conn: sqlite3.Connection, weights: dict, symbol: str = "GC",
            today: str | None = None) -> list[FitResult]:
    """Every fit this deployment can currently support.

    Two fits, not one. Technical signals backfill five years while scored news
    starts 2026-08-19, so a single joint fit over all history would have every
    theme column zero for ~99.9% of rows: theme coefficients estimated from
    tens of rows while the reported n said thousands, making the confidence
    treatment overstate certainty exactly where it is least deserved.

    Fit B carries the signal states as CONTROLS and reports only the themes.
    The control coefficients are discarded — they exist so a news effect is
    not credited with a move the tape was already making, not to become a
    second, contradictory set of technical weights alongside Fit A's.

    A full refit from history each time, not an incremental nudge:
    idempotent, reproducible, no drift.
    """
    cfg = fit_config(weights)
    pins = active_pins(weights, (today or utcnow())[:10])
    results: list[FitResult] = []

    a = run_fit("technical", build_technical(conn, weights, symbol), cfg, pins)
    if a is not None:
        results.append(a)

    theme_data = build_theme(conn, weights, symbol)
    b = run_fit("theme", theme_data, cfg, pins, report_columns=themes(weights))
    if b is not None:
        results.append(b)

    return results
```

and add `build_theme` to the `jamasp.features` import at the top of the module.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_fit.py -v`
Expected: PASS

- [ ] **Step 5: Add the systemd units**

Create `ops/systemd/jamasp-weights.service`:

```ini
[Unit]
Description=Jamasp weights — refresh bars, signal states and the ridge fits
OnFailure=jamasp-alert@%n.service

[Service]
Type=oneshot
# The backfill re-walks 730 days of hourly bars and five years of daily ones,
# then two ridge fits run over ~17k rows. Comfortable, but a wedged socket
# must not hold the daily timer down forever.
TimeoutStartSec=900
WorkingDirectory=%h/Jamasp
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.config/jamasp/env
# Deterministic pipeline stage, not an agent run: no `jamasp run` wrapper, so
# it consumes none of the daily agent-run cap — same as the flash pass.
#
# Order matters. bars backfill is idempotent and is also the refresh path, so
# it runs first; signals refresh reads those bars; weights fit recomputes
# every historical state from bars itself and does not read signal_states, but
# running it last means a single failed unit leaves nothing half-updated.
ExecStart=%h/.local/bin/uv run jamasp bars backfill
ExecStart=%h/.local/bin/uv run jamasp signals refresh
ExecStart=%h/.local/bin/uv run jamasp weights fit
```

Create `ops/systemd/jamasp-weights.timer`:

```ini
[Unit]
Description=Refit the Jamasp map multipliers daily at 03:30 Dubai

[Timer]
# Before the 07:30 brief, so the desk's first read of the day is on
# multipliers fitted through yesterday's close.
OnCalendar=*-*-* 03:30:00 Asia/Dubai
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
```

- [ ] **Step 6: Update the docs**

In `CLAUDE.md`, add three rows to the toolbox table after the `calendar` row:

```markdown
| `uv run jamasp bars backfill` | refresh OHLC bars (idempotent; also the daily refresh) |
| `uv run jamasp signals refresh` | recompute current technical signal states |
| `uv run jamasp weights fit` | refit the market maps' learned multipliers |
```

In `CLAUDE.md`'s Deployment section, change "seven systemd timers" to "eight systemd timers" and add the weights timer to the list: "…, the 4x-daily news-channel rollup, and a daily weights refit".

In `.claude/skills/deploy/SKILL.md`, change "All 14 unit files (7 services + 7 timers: ingest, brief, scan, dispatch, retro, watchdog, flash-rollup)" to "All 16 unit files (8 services + 8 timers: ingest, brief, scan, dispatch, retro, watchdog, flash-rollup, weights)", and add `jamasp-weights.timer` to the deterministic-infra enable line:

```bash
systemctl --user enable --now jamasp-ingest.timer jamasp-dispatch.timer jamasp-watchdog.timer jamasp-flash-rollup.timer jamasp-weights.timer
```

Add to the Timer OnCalendar list in the same section: "weights `03:30` Dubai".

- [ ] **Step 7: Verify the units parse**

Run: `uv run python -c "import configparser,glob; [configparser.ConfigParser(strict=False, allow_no_value=True).read(f) for f in glob.glob('ops/systemd/jamasp-weights.*')]; print('ok')"`
Expected: `ok`

Note: `ExecStart` appears three times in the service, which `configparser` in strict mode would reject and systemd accepts — hence `strict=False`. That repetition is the intended systemd idiom for a sequential oneshot, not a mistake.

- [ ] **Step 8: Run the whole suite and commit**

Run: `uv run pytest -q`
Expected: PASS

Stage `jamasp/fit.py`, `tests/test_fit.py`, `ops/systemd/jamasp-weights.service`, `ops/systemd/jamasp-weights.timer`, `CLAUDE.md`, `.claude/skills/deploy/SKILL.md` and commit with:

```
feat(fit): Fit B — theme weights with the technical states as controls

Two fits, not one. Technical signals backfill five years while scored news
starts 2026-08-19, so a single joint fit would have every theme column zero
for ~99.9% of rows — theme coefficients estimated from tens of rows while
the reported n said thousands, which makes the confidence treatment
overstate certainty exactly where it is least deserved.

Fit B fits over themes AND the 38 signal columns, then reports only the
themes. The control coefficients are discarded: they exist so a news effect
is not credited with a move the tape was already making, not to become a
second contradictory set of technical weights alongside Fit A's. The test
worth reading is the one where a theme's apparent effect is entirely
explained by a concurrent technical state and the controlled coefficient
collapses to a quarter of the naive one.

The daily timer runs backfill, signals refresh and the fits in order, with
no `jamasp run` wrapper — a deterministic pipeline stage that consumes none
of the agent-run cap, same class of job as the flash pass.
```

---

### Task 9: Panel — the technical map's data layer

**Files:**
- Create: `panel/lib/technicalmap.ts`
- Create: `panel/test/technicalmap.test.ts`
- Modify: `panel/lib/marketmap.ts` (add `toneFromIntensity`, generalise the layout)
- Modify: `panel/lib/db.ts` (add `latestSignalStates`)
- Modify: `panel/lib/files.ts` (add `readFittedWeights`, `loadWeightsConfig`)
- Modify: `panel/test/marketmap.test.ts`, `panel/test/db-marketmap.test.ts`, `panel/test/files.test.ts`

**Interfaces:**
- Consumes: `Rect`, `Cell`, `squarify`, `Tone`, `tone` (all already exported from `panel/lib/marketmap.ts`).
- Produces:
  - In `marketmap.ts`: `toneFromIntensity(s: number): Tone`; `GroupNode<T> = { group: string; value: number; node: T }`; `GroupBox<T> = Rect & { group: string; items: Cell<T>[]; total: number }`; `layoutGroups<T>(nodes: GroupNode<T>[], rect: Rect, headerHeight: number): GroupBox<T>[]`. `layoutMap` keeps its exact current signature and return shape (`ThemeBox[]`, with `.theme`) and becomes a thin adapter over `layoutGroups`.
  - In `technicalmap.ts`: `SignalState = { key: string; ts: string; value: number }`; `SignalTile = { key: string; signal: string; timeframe: string; family: string; state: number; ts: string; multiplier: number; fitted: boolean }`; `FittedWeights` (see below); `buildSignalTiles(states, specs, weights): SignalTile[]`; `layoutSignalMap(tiles, rect, headerHeight): GroupBox<SignalTile>[]`.
  - In `db.ts`: `latestSignalStates(): SignalState[]`.
  - In `files.ts`: `readFittedWeights(): FittedWeights | null`; `loadWeightsConfig(): WeightsConfig`.

```ts
export type FittedCoefficient = {
  beta: number; se: number; multiplier: number; observations: number; fitted: boolean;
};
export type FittedWeights = {
  fittedAt: string;
  fits: Record<string, { n: number; horizonHours: number; flags: string[];
                         coefficients: Record<string, FittedCoefficient> }>;
};
export type WeightsConfig = {
  themes: string[];
  signals: { name: string; family: string; timeframes: string[] }[];
};
```

**Context you need:** `panel/lib/marketmap.ts` already exports `squarify` and `layoutMap`; `layoutMap` groups `ScoredItem[]` by `.theme` and lays out two levels. The technical map is the same two-level layout over different nodes, so generalising is the right move and duplicating a 25-line squarify wrapper is not — the review rubric treats verbatim duplication of a logic block as a defect. **`layoutMap`'s public shape must not change**: `panel/test/marketmap.test.ts` and `panel/components/market-map.tsx` both read `.theme`, and this task is not the place to churn them.

`tone(direction, conviction)` computes `s = (direction / 2) * conviction` and bands it. A signal state is already that `s`, so `toneFromIntensity` is the band logic alone and `tone` delegates. Do not duplicate the 0.15/0.55 thresholds.

`panel/lib/db.ts` has a `hasTable` guard and a `q()` wrapper that retries once on `SQLITE_BUSY` — both are mandatory for any new reader. `state/weights.json` will not exist until the first `jamasp weights fit` runs, so `readFittedWeights` returns `null` rather than throwing.

- [ ] **Step 1: Write the failing layout and tone tests**

Append to `panel/test/marketmap.test.ts`. Note that this file imports from `"../lib/marketmap"` with a **relative** path, not the `@/` alias — extend its existing import line rather than adding a second one:

```ts
// at the top of the file, extend the existing import:
// import { layoutGroups, layoutMap, squarify, tierWeight, tone,
//          toneFromIntensity, type ScoredItem } from "../lib/marketmap";

describe("toneFromIntensity", () => {
  it("bands a signed intensity onto the five-step ramp", () => {
    expect(toneFromIntensity(0)).toBe("neutral");
    expect(toneFromIntensity(0.1)).toBe("neutral");
    expect(toneFromIntensity(0.3)).toBe("bull-mid");
    expect(toneFromIntensity(0.9)).toBe("bull");
    expect(toneFromIntensity(-0.3)).toBe("bear-mid");
    expect(toneFromIntensity(-0.9)).toBe("bear");
  });

  it("agrees with tone() on the same intensity", () => {
    // tone() computes s = (direction/2) * conviction and bands it, so the two
    // must never band the same s differently — the thresholds live in one
    // place precisely so a future edit cannot desynchronise the two maps.
    expect(tone(2, 0.9)).toBe(toneFromIntensity(0.9));
    expect(tone(-1, 0.6)).toBe(toneFromIntensity(-0.3));
  });
});

describe("layoutGroups", () => {
  const rect = { x: 0, y: 0, w: 400, h: 300 };

  it("lays out groups then their children below a header strip", () => {
    const boxes = layoutGroups([
      { group: "a", value: 3, node: "a1" },
      { group: "a", value: 1, node: "a2" },
      { group: "b", value: 2, node: "b1" },
    ], rect, 20);
    expect(boxes.map(b => b.group).sort()).toEqual(["a", "b"]);
    const a = boxes.find(b => b.group === "a")!;
    expect(a.total).toBe(4);
    expect(a.items).toHaveLength(2);
    for (const cell of a.items) expect(cell.y).toBeGreaterThanOrEqual(a.y + 20);
  });

  it("omits a group whose children all have zero value", () => {
    const boxes = layoutGroups([{ group: "a", value: 0, node: "a1" }], rect, 20);
    expect(boxes).toEqual([]);
  });

  it("keeps layoutMap's existing shape", () => {
    // layoutMap is the adapter; its consumers read .theme and must not churn.
    const items = [
      { itemId: "1", tier: 5, direction: 2, conviction: 0.8, theme: "rates_dollar",
        headline: "h", source: "s", url: "u", publishedAt: "2026-08-20T00:00:00Z" },
    ];
    const boxes = layoutMap(items, rect, 20);
    expect(boxes[0].theme).toBe("rates_dollar");
    expect(boxes[0].items[0].node.itemId).toBe("1");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd panel && npx vitest run test/marketmap.test.ts`
Expected: FAIL — `layoutGroups` and `toneFromIntensity` are not exported.

- [ ] **Step 3: Generalise `marketmap.ts`**

Replace `tone` and `layoutMap` in `panel/lib/marketmap.ts` with:

```ts
/**
 * Band a signed intensity in [-1, +1] onto the five-step diverging ramp.
 *
 * This is the band logic on its own, because both maps need it from
 * different inputs: the fundamental map derives an intensity from direction
 * and conviction, while a technical signal's state IS an intensity already.
 * The thresholds live here once so a future edit cannot make the two maps
 * disagree about where "neutral" ends.
 */
export function toneFromIntensity(s: number): Tone {
  const a = Math.abs(s);
  if (a < NEUTRAL_BAND) return "neutral";
  if (a < POLE_BAND) return s < 0 ? "bear-mid" : "bull-mid";
  return s < 0 ? "bear" : "bull";
}

/**
 * Signed intensity s = (direction / 2) * conviction, in [-1, +1], mapped onto
 * the five-step diverging ramp.
 *
 * Conviction multiplies rather than gates: direction says which way, and
 * conviction says how far along that arm to travel. A confident +1 and a
 * hesitant +2 can legitimately land on the same step.
 */
export function tone(direction: number, conviction: number): Tone {
  return toneFromIntensity((direction / 2) * conviction);
}

export type GroupNode<T> = { group: string; value: number; node: T };
export type GroupBox<T> = Rect & { group: string; items: Cell<T>[]; total: number };

/**
 * Two-level layout: groups fill the canvas, each group's children fill its
 * box below a reserved header strip.
 *
 * Generic over the node type because both maps are this same layout over
 * different nodes — stories grouped by theme, signals grouped by family.
 * Duplicating it per map would leave two squarify wrappers to keep in step.
 *
 * Groups with no positive-value children are absent rather than empty. An
 * empty box would claim area and read as "nothing happened in this channel"
 * when what it means is "nothing was filed here" — a different claim, and
 * one the coverage footer is the honest place for.
 */
export function layoutGroups<T>(
  nodes: GroupNode<T>[], rect: Rect, headerHeight: number,
): GroupBox<T>[] {
  const grouped = new Map<string, GroupNode<T>[]>();
  for (const n of nodes) {
    const bucket = grouped.get(n.group);
    if (bucket) bucket.push(n);
    else grouped.set(n.group, [n]);
  }

  const groups = [...grouped.entries()].map(([group, kids]) => ({
    value: kids.reduce((s, k) => s + k.value, 0),
    node: { group, kids },
  }));

  return squarify(groups, rect).map(cell => {
    const inner: Rect = {
      x: cell.x,
      y: cell.y + headerHeight,
      w: cell.w,
      h: Math.max(0, cell.h - headerHeight),
    };
    return {
      x: cell.x, y: cell.y, w: cell.w, h: cell.h,
      group: cell.node.group,
      total: cell.node.kids.reduce((s, k) => s + k.value, 0),
      items: squarify(
        cell.node.kids.map(k => ({ value: k.value, node: k.node })), inner),
    };
  });
}

/**
 * The fundamental map's layout: stories grouped by theme, sized by tier.
 *
 * A thin adapter over layoutGroups, keeping `.theme` on the returned boxes
 * because this component and its tests have always read that name.
 */
export function layoutMap(
  items: ScoredItem[], rect: Rect, headerHeight: number,
): ThemeBox[] {
  const boxes = layoutGroups(
    items.map(it => ({ group: it.theme, value: tierWeight(it.tier), node: it })),
    rect, headerHeight);
  return boxes.map(b => ({
    x: b.x, y: b.y, w: b.w, h: b.h,
    theme: b.group, items: b.items, total: b.total,
  }));
}
```

Run: `cd panel && npx vitest run test/marketmap.test.ts`
Expected: PASS

- [ ] **Step 4: Write the failing reader tests**

`panel/test/db-marketmap.test.ts` builds one fixture database in a `beforeAll` and holds the module in a file-level `let db` (vitest isolates files into separate workers, so each import of `lib/db` binds its own root). Follow that idiom exactly — there is no per-test database helper in this file. Add `signal_states` to the schema its `beforeAll` executes:

```sql
    CREATE TABLE signal_states (key TEXT NOT NULL, ts TEXT NOT NULL,
      value REAL NOT NULL, PRIMARY KEY (key, ts));
    INSERT INTO signal_states VALUES
      ('rsi14@1d', '2026-08-19T00:00:00Z', -0.5),
      ('rsi14@1d', '2026-08-20T00:00:00Z',  0.5),
      ('sma50@1d', '2026-08-20T00:00:00Z', -1.0);
```

and append:

```ts
describe("latestSignalStates", () => {
  it("returns the newest row per key", () => {
    const rows = db.latestSignalStates();
    expect(rows).toHaveLength(2);
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
    // rsi14@1d has two rows a day apart; the older -0.5 must not win.
    expect(byKey["rsi14@1d"]).toBe(0.5);
    expect(byKey["sma50@1d"]).toBe(-1.0);
  });
});
```

The missing-table case belongs in `panel/test/db-marketmap-no-table.test.ts`, whose fixture deliberately creates `items` and nothing else — append there:

```ts
describe("latestSignalStates against a database with no signal_states table", () => {
  it("returns an empty array rather than throwing", () => {
    // A host that has not run `jamasp signals refresh` yet must still serve
    // the overview page — the same guard getScoredItems carries.
    expect(() => db.latestSignalStates()).not.toThrow();
    expect(db.latestSignalStates()).toEqual([]);
  });
});
```

`panel/test/files.test.ts` points `JAMASP_ROOT` at the **shared** `test/fixtures/root`, which `npm run fixture` will also populate with a `state/weights.json` in Task 10 — so a "file does not exist" assertion against that root would pass or fail depending on whether the e2e fixture had been built. These tests need their own throwaway root. Add the helper and the block:

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { vi } from "vitest";

/**
 * Run `fn` against a throwaway JAMASP_ROOT containing exactly `contents`.
 *
 * lib/paths.ts resolves JAMASP_ROOT at module load, so the module has to be
 * re-imported after the env var changes — hence resetModules. A separate root
 * matters here specifically: this file's shared fixture root also receives a
 * state/weights.json from `npm run fixture`, which would make the
 * file-is-absent assertion below depend on whether e2e had been built.
 */
async function withRoot(
  contents: Record<string, string>,
  fn: (m: typeof import("../lib/files")) => void,
) {
  const root = mkdtempSync(path.join(tmpdir(), "jamasp-weights-"));
  mkdirSync(path.join(root, "state"), { recursive: true });
  for (const [rel, body] of Object.entries(contents)) {
    writeFileSync(path.join(root, rel), body);
  }
  const prev = process.env.JAMASP_ROOT;
  process.env.JAMASP_ROOT = root;
  vi.resetModules();
  try {
    fn(await import("../lib/files"));
  } finally {
    process.env.JAMASP_ROOT = prev;
    vi.resetModules();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("readFittedWeights", () => {
  const doc = JSON.stringify({
    fitted_at: "2026-08-20T04:17:00Z",
    fits: { technical: { n: 16880, horizon_hours: 24, flags: [],
      coefficients: { "rsi14@1d": { beta: 0.03, se: 0.008, multiplier: 1.4,
                                    observations: 900, fitted: true } } } },
  });

  it("parses state/weights.json into camelCase", async () => {
    await withRoot({ "state/weights.json": doc }, m => {
      const w = m.readFittedWeights()!;
      expect(w.fittedAt).toBe("2026-08-20T04:17:00Z");
      expect(w.fits.technical.n).toBe(16880);
      expect(w.fits.technical.horizonHours).toBe(24);
      expect(w.fits.technical.coefficients["rsi14@1d"].multiplier).toBe(1.4);
    });
  });

  it("returns null when the file does not exist", async () => {
    // It will not, until the first `jamasp weights fit` runs. Every tile
    // renders neutral and dashed in that window rather than the page failing.
    await withRoot({}, m => expect(m.readFittedWeights()).toBeNull());
  });

  it("returns null on malformed JSON rather than throwing", async () => {
    // A fit interrupted mid-write would surface as a JSON parse error on a
    // live page. write_results renames into place for that reason; this is
    // the belt to that braces.
    await withRoot({ "state/weights.json": "{ truncated" }, m => {
      expect(() => m.readFittedWeights()).not.toThrow();
      expect(m.readFittedWeights()).toBeNull();
    });
  });
});
```

- [ ] **Step 5: Implement the readers**

In `panel/lib/db.ts`:

```ts
export type SignalState = { key: string; ts: string; value: number };

/**
 * The newest state per signal column.
 *
 * Same missing-table guard as getScoredItems: a host that has not run
 * `jamasp signals refresh` yet has no signal_states, and the overview page
 * must keep serving through that window rather than 500ing on one panel.
 */
export function latestSignalStates(): SignalState[] {
  return q(db => {
    if (!hasTable(db, "signal_states")) return [];
    return db.prepare(`
      SELECT key, ts, value FROM (
        SELECT key, ts, value,
               ROW_NUMBER() OVER (PARTITION BY key ORDER BY ts DESC) AS rn
          FROM signal_states)
       WHERE rn = 1
       ORDER BY key
    `).all() as SignalState[];
  });
}
```

In `panel/lib/files.ts`:

```ts
/**
 * The daily fit's measurements. Null until the first `jamasp weights fit`
 * runs, and null again if the file is unreadable — the maps render every
 * tile neutral and dashed in that window rather than taking the page down.
 *
 * snake_case in, camelCase out: the file is written by Python and read by
 * TypeScript, and letting Python's naming leak into the panel's types is how
 * `fitted_at` ends up half-renamed across a dozen call sites later.
 */
export function readFittedWeights(): FittedWeights | null {
  const raw = readText(path.join(STATE_DIR, "weights.json"));
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as Record<string, never>;
    const fits: FittedWeights["fits"] = {};
    for (const [name, f] of Object.entries(
      (doc.fits ?? {}) as Record<string, Record<string, never>>)) {
      fits[name] = {
        n: Number(f.n ?? 0),
        horizonHours: Number(f.horizon_hours ?? 0),
        flags: (f.flags ?? []) as unknown as string[],
        coefficients: (f.coefficients ?? {}) as unknown as
          Record<string, FittedCoefficient>,
      };
    }
    return { fittedAt: String(doc.fitted_at ?? ""), fits };
  } catch {
    return null;
  }
}

export function loadWeightsConfig(): WeightsConfig {
  const raw = readText(path.join(CONFIG_DIR, "weights.yaml"));
  if (!raw) return { themes: [], signals: [] };
  const doc = YAML.parse(raw) as WeightsConfig | null;
  return { themes: doc?.themes ?? [], signals: doc?.signals ?? [] };
}
```

**Ordering note:** `readFittedWeights` and `loadWeightsConfig` reference `FittedWeights`, `FittedCoefficient` and `WeightsConfig`, which Step 6 defines in `@/lib/technicalmap`. Write Step 6's type declarations first (the rest of that file can wait), then come back and add the `import type` line here — otherwise `tsc` fails on a module that does not exist yet and Step 5 cannot be verified in isolation.

Both new readers also assume `readText`, `STATE_DIR`, `CONFIG_DIR` and `YAML` are already in scope in `panel/lib/files.ts` — they are; do not re-import them.

- [ ] **Step 6: Write the failing `technicalmap.ts` tests**

Create `panel/test/technicalmap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSignalTiles, layoutSignalMap } from "@/lib/technicalmap";

const SPECS = [
  { name: "rsi14", family: "momentum", timeframes: ["1d", "4h"] },
  { name: "sma50", family: "trend", timeframes: ["1d"] },
];

const WEIGHTS = {
  fittedAt: "2026-08-20T04:17:00Z",
  fits: {
    technical: {
      n: 16880, horizonHours: 24, flags: [],
      coefficients: {
        "rsi14@1d": { beta: 0.03, se: 0.008, multiplier: 2.0,
                      observations: 900, fitted: true },
        "rsi14@4h": { beta: 0.001, se: 0.02, multiplier: 1.0,
                      observations: 3, fitted: false },
      },
    },
  },
};

const STATES = [
  { key: "rsi14@1d", ts: "2026-08-20T00:00:00Z", value: 0.8 },
  { key: "rsi14@4h", ts: "2026-08-20T04:00:00Z", value: -0.3 },
  { key: "sma50@1d", ts: "2026-08-20T00:00:00Z", value: -0.9 },
];

describe("buildSignalTiles", () => {
  it("joins states to their family and their fitted multiplier", () => {
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    const byKey = Object.fromEntries(tiles.map(t => [t.key, t]));
    expect(byKey["rsi14@1d"].family).toBe("momentum");
    expect(byKey["rsi14@1d"].multiplier).toBe(2.0);
    expect(byKey["rsi14@1d"].fitted).toBe(true);
    expect(byKey["rsi14@1d"].state).toBe(0.8);
    expect(byKey["rsi14@1d"].signal).toBe("rsi14");
    expect(byKey["rsi14@1d"].timeframe).toBe("1d");
  });

  it("gives a column with no fitted coefficient a neutral, unfitted weight", () => {
    // Before the first fit every multiplier is 1.0 and the map is a uniform
    // grid. That is honest rather than broken — but it must be visibly
    // unfitted, or a grid of equal tiles reads as a measurement.
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    const sma = tiles.find(t => t.key === "sma50@1d")!;
    expect(sma.multiplier).toBe(1);
    expect(sma.fitted).toBe(false);
  });

  it("treats an under-observed column as unfitted even though it has a coefficient", () => {
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    expect(tiles.find(t => t.key === "rsi14@4h")!.fitted).toBe(false);
  });

  it("renders everything neutral and unfitted with no weights file at all", () => {
    const tiles = buildSignalTiles(STATES, SPECS, null);
    expect(tiles).toHaveLength(3);
    expect(tiles.every(t => t.multiplier === 1 && !t.fitted)).toBe(true);
  });

  it("drops a state whose column is not in the configured taxonomy", () => {
    // A stale signal_states row from a removed signal must not draw a tile
    // with no family to sit in.
    const tiles = buildSignalTiles(
      [...STATES, { key: "vibes@1d", ts: "2026-08-20T00:00:00Z", value: 1 }],
      SPECS, WEIGHTS);
    expect(tiles.map(t => t.key)).not.toContain("vibes@1d");
  });

  it("is empty when there are no states", () => {
    expect(buildSignalTiles([], SPECS, WEIGHTS)).toEqual([]);
  });
});

describe("layoutSignalMap", () => {
  it("groups by family and sizes by multiplier alone", () => {
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    const boxes = layoutSignalMap(tiles, { x: 0, y: 0, w: 400, h: 300 }, 20);
    expect(boxes.map(b => b.group).sort()).toEqual(["momentum", "trend"]);
    const momentum = boxes.find(b => b.group === "momentum")!;
    // rsi14@1d has multiplier 2.0 and rsi14@4h has 1.0, so the first tile
    // must be twice the area of the second. There is no tier for a signal:
    // area is the learned multiplier and nothing else, which is what makes
    // the Bourse analogy exact — shape is stable, colour is today's read.
    const areas = momentum.items
      .map(c => ({ key: c.node.key, area: c.w * c.h }));
    const big = areas.find(a => a.key === "rsi14@1d")!.area;
    const small = areas.find(a => a.key === "rsi14@4h")!.area;
    expect(big / small).toBeCloseTo(2.0, 2);
  });

  it("fills the whole canvas", () => {
    const tiles = buildSignalTiles(STATES, SPECS, WEIGHTS);
    const boxes = layoutSignalMap(tiles, { x: 0, y: 0, w: 400, h: 300 }, 0);
    const total = boxes.reduce((s, b) => s + b.w * b.h, 0);
    // Compare the RATIO, not the absolute area. toBeCloseTo(120000, 4) demands
    // agreement to 0.00005 on a six-figure number, which squarify's IEEE
    // round-trips cannot promise — the same trap that produced a spurious
    // failure at 399.99999999999994 when this layout first landed.
    expect(total / (400 * 300)).toBeCloseTo(1, 6);
  });
});
```

- [ ] **Step 7: Implement `panel/lib/technicalmap.ts`**

```ts
/**
 * Technical market map: encoding and layout.
 *
 * Pure, like lib/marketmap.ts — the page does the database read and passes
 * rows in.
 *
 * Two things differ from the fundamental map, and both are deliberate.
 *
 * AREA is the learned multiplier ALONE. There is no tier for a signal. That
 * is what makes the Bourse analogy exact: there, market cap is stable and
 * sets the shape while the day's move sets the colour. Here the multiplier —
 * how much a signal has historically mattered — sets the shape, and the
 * current state sets the colour. A consequence worth stating: this map's
 * shape barely changes between refreshes. That is correct, not stale.
 *
 * COLOUR is the signal's state, already a single number in [-1, +1], mapped
 * onto the same five-step ramp with the same mandatory hatch on BOTH bearish
 * tones.
 *
 * Before the first fit every multiplier is 1.0, so the map reads as a uniform
 * grid. Honest, but it looks odd — which is why unfitted tiles are drawn with
 * a dashed outline rather than silently rendering as a measurement.
 */
import {
  layoutGroups, type GroupBox, type Rect,
} from "@/lib/marketmap";

export type SignalState = { key: string; ts: string; value: number };

export type SignalSpecConfig = {
  name: string; family: string; timeframes: string[];
};

export type WeightsConfig = {
  themes: string[];
  signals: SignalSpecConfig[];
};

export type FittedCoefficient = {
  beta: number; se: number; multiplier: number;
  observations: number; fitted: boolean;
};

export type FittedWeights = {
  fittedAt: string;
  fits: Record<string, {
    n: number; horizonHours: number; flags: string[];
    coefficients: Record<string, FittedCoefficient>;
  }>;
};

export type SignalTile = {
  key: string; signal: string; timeframe: string; family: string;
  state: number; ts: string; multiplier: number; fitted: boolean;
};

/** What every tile weighs before anything has been learned. */
export const NEUTRAL_MULTIPLIER = 1;

export function buildSignalTiles(
  states: SignalState[],
  specs: SignalSpecConfig[],
  weights: FittedWeights | null,
): SignalTile[] {
  const family = new Map<string, string>();
  for (const s of specs) {
    for (const tf of s.timeframes) family.set(`${s.name}@${tf}`, s.family);
  }
  const coefficients = weights?.fits?.technical?.coefficients ?? {};

  const out: SignalTile[] = [];
  for (const st of states) {
    const fam = family.get(st.key);
    // A stale row from a signal that has since been removed from the
    // taxonomy has no family to sit in; drawing it would invent a group.
    if (!fam) continue;
    const [signal, timeframe] = st.key.split("@");
    const c = coefficients[st.key];
    const fitted = c?.fitted === true;
    out.push({
      key: st.key, signal, timeframe, family: fam,
      state: st.value, ts: st.ts,
      // An unfitted column weighs neutral whatever number happens to sit in
      // the file: a coefficient from three observations is not a measurement,
      // and sizing a tile by it would render confidence nobody earned.
      multiplier: fitted ? c.multiplier : NEUTRAL_MULTIPLIER,
      fitted,
    });
  }
  return out;
}

export function layoutSignalMap(
  tiles: SignalTile[], rect: Rect, headerHeight: number,
): GroupBox<SignalTile>[] {
  return layoutGroups(
    tiles.map(t => ({ group: t.family, value: t.multiplier, node: t })),
    rect, headerHeight);
}
```

- [ ] **Step 8: Run the panel suite and the type check**

Run: `cd panel && npm test && npx tsc --noEmit`
Expected: PASS, with no type errors.

- [ ] **Step 9: Commit**

Stage `panel/lib/technicalmap.ts`, `panel/lib/marketmap.ts`, `panel/lib/db.ts`, `panel/lib/files.ts` and the four test files, and commit with:

```
feat(panel): technical map data layer

layoutMap generalises into layoutGroups rather than being duplicated: both
maps are the same two-level squarify over different nodes, and two copies
would be two places to keep in step. layoutMap keeps its exact signature
and .theme naming — its consumers are not this change's business.

toneFromIntensity holds the band thresholds once. tone() delegates to it,
so a future edit cannot make the two maps disagree about where neutral ends.

Area on the technical map is the learned multiplier ALONE — there is no
tier for a signal. That is what makes the Bourse analogy exact: the
multiplier sets the shape, today's state sets the colour. An unfitted
column weighs neutral whatever number sits in the file, because a
coefficient from three observations is not a measurement.
```

---

### Task 10: Panel — the technical map on the page

**Files:**
- Create: `panel/components/map-tiles.tsx`
- Create: `panel/components/technical-map.tsx`
- Create: `panel/test/technical-map.test.tsx`
- Modify: `panel/components/market-map.tsx` (use the shared tile primitives)
- Modify: `panel/app/page.tsx`
- Modify: `panel/test/market-map-wrap.test.ts` (import moves), `panel/test/market-map.test.tsx`
- Modify: `panel/scripts/build-fixture.mjs`, `panel/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: `buildSignalTiles`, `layoutSignalMap`, `SignalTile` (Task 9); `toneFromIntensity`, `Tone` (Task 9); `latestSignalStates` (Task 9); `readFittedWeights`, `loadWeightsConfig` (Task 9).
- Produces:
  - `panel/components/map-tiles.tsx`: `MAP_HATCH_ID = "map-hatch"`; `MapHatchDefs()`; `MapTile(props: { x, y, w, h, tone: Tone, title: string, lines: string[], dashed?: boolean })`; `MapLegend()`; and the label helpers moved here — `LABEL_FONT`, `LABEL_PAD`, `LINE_H`, `AVG_CHAR_W`, `MIN_LABEL_W`, `MIN_LABEL_H`, `truncateForWidth`, `wrapForTile`.
  - `panel/components/technical-map.tsx`: `TECHNICAL_MAP_ELEMENT_ID = "technical-map"`; `TechnicalMap({ tiles, width, height, fittedAt })`.

**Why extract rather than duplicate.** The hatch `<defs>`, the tone→fill/ink tables, the label wrapping and the `<title>`-on-the-group trick are all load-bearing correctness, not styling. `market-map.tsx`'s own comment records why: the hatch overlay becomes the topmost hit target and would swallow the tooltip on every bearish tile if `<title>` sat on the rect. A second copy of that in `technical-map.tsx` would be a second place for it to regress. Move it once; both maps import it.

**The hatch predicate is not negotiable.** `bear` **and** `bear-mid`, never just the pole. Two ramp pairs fail CVD outright — bear/bull-mid at ΔE 2.8 for protanopes, bear-mid/bull-mid at ΔE 3.1 for deuteranopes — and hatching both bearish tones is what gives every failing pair exactly one hatched member.

- [ ] **Step 1: Extract the shared tile primitives**

Create `panel/components/map-tiles.tsx` by **moving** — not copying — these from `panel/components/market-map.tsx`, comments intact: `TONE_FILL`, `TONE_INK`, `isBearish`, `LABEL_FONT`, `LABEL_PAD`, `AVG_CHAR_W`, `MIN_LABEL_W`, `MIN_LABEL_H`, `LINE_H`, `truncateForWidth`, `wrapForTile`, and the `<pattern id="map-hatch">` block. Export every one of them — `market-map.tsx` and `technical-map.tsx` both import them by name.

The new file needs `import { type Tone } from "@/lib/marketmap";` at the top, which `market-map.tsx` currently gets as part of its own import list.

Add on top:

```tsx
/**
 * Tile primitives shared by both market maps.
 *
 * This file exists so the correctness-bearing parts of a tile live in one
 * place: the hatch that makes two CVD-failing colour pairs separable, the
 * <title> that has to sit on the group rather than the rect, and the label
 * wrapping. A second copy in the technical map would be a second place for
 * each of those to regress, and they are the parts nobody re-derives when
 * they regress.
 */

export const MAP_HATCH_ID = "map-hatch";

/**
 * The hatch pattern definition. Every SVG that paints a bearish tile must
 * render this once — a url(#map-hatch) reference into an SVG that has no
 * such pattern paints nothing, which silently removes the second encoding
 * rather than failing visibly.
 */
export function MapHatchDefs() {
  return (
    <defs>
      <pattern id={MAP_HATCH_ID} patternUnits="userSpaceOnUse" width="6" height="6"
        patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="black" strokeOpacity="0.25"
          strokeWidth="2" />
      </pattern>
    </defs>
  );
}

/**
 * One tile: fill, mandatory hatch on both bearish tones, hover title, and
 * wrapped label lines.
 *
 * `dashed` marks a weight that has not been fitted yet. Solid means measured;
 * dashed means "this is 1.0 for want of a sample", which on a map whose area
 * channel encodes learned importance is the difference between a claim and a
 * placeholder.
 */
export function MapTile({ x, y, w, h, tone, title, lines, dashed = false }: {
  x: number; y: number; w: number; h: number;
  tone: Tone; title: string; lines: string[]; dashed?: boolean;
}) {
  return (
    <g>
      {/* <title> lives on the group, not the base rect: under default
          pointer-events, the hatch overlay below paints on top of the base
          rect and becomes the topmost hit target, which would otherwise
          swallow the tooltip on every bearish tile. A title on the group
          survives whichever child is actually hit. */}
      <title>{title}</title>
      <rect x={x} y={y} width={w} height={h} fill={TONE_FILL[tone]}
        stroke="var(--background)" strokeWidth="1"
        strokeDasharray={dashed ? "3 2" : undefined} />
      {isBearish(tone) && (
        <rect x={x} y={y} width={w} height={h}
          fill={`url(#${MAP_HATCH_ID})`} pointerEvents="none" />
      )}
      {lines.length > 0 && (
        <text x={x + LABEL_PAD} y={y + LABEL_PAD + LABEL_FONT * 0.8}
          fontSize={LABEL_FONT} fill={TONE_INK[tone]}>
          {lines.map((line, i) => (
            // Each tspan repeats x so the line returns to the tile's left
            // edge; dy advances all but the first.
            <tspan key={i} x={x + LABEL_PAD} dy={i === 0 ? 0 : LINE_H}>{line}</tspan>
          ))}
        </text>
      )}
    </g>
  );
}
```

Move the existing `Legend` function here too, exported as `MapLegend`, keeping its comment about drawing the swatch with CSS rather than a `url(#map-hatch)` reference (the compliance test asserts that string appears only on actually-bearish tiles).

- [ ] **Step 2: Rewire `market-map.tsx` and fix the moved imports**

In `panel/components/market-map.tsx`, delete the moved code and import from `@/components/map-tiles`, then replace each tile's inline `<g>…</g>` with `<MapTile>` and the `<defs>` block with `<MapHatchDefs />` and the legend with `<MapLegend />`.

In `panel/test/market-map-wrap.test.ts`, change `import { wrapForTile } from "../components/market-map";` to `import { wrapForTile } from "../components/map-tiles";` — keep the relative form the file already uses.

Run: `cd panel && npm test`
Expected: PASS — every existing market-map test, unchanged in substance. If `market-map.test.tsx`'s hatch-compliance assertion fails, the extraction dropped the both-tones predicate; restore it rather than relaxing the test.

- [ ] **Step 3: Write the failing technical-map tests**

Create `panel/test/technical-map.test.tsx`, following the render idiom already used by `panel/test/market-map.test.tsx` (read it first):

```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TechnicalMap } from "@/components/technical-map";
import type { SignalTile } from "@/lib/technicalmap";

const tile = (over: Partial<SignalTile> = {}): SignalTile => ({
  key: "rsi14@1d", signal: "rsi14", timeframe: "1d", family: "momentum",
  state: 0.8, ts: "2026-08-20T00:00:00Z", multiplier: 2, fitted: true, ...over,
});

const render = (tiles: SignalTile[]) =>
  renderToStaticMarkup(
    <TechnicalMap tiles={tiles} width={1200} height={600}
      fittedAt="2026-08-20T04:17:00Z" />);

describe("TechnicalMap", () => {
  it("renders a tile per signal, grouped by family", () => {
    const html = render([tile(), tile({ key: "sma50@1d", signal: "sma50",
      family: "trend", state: -0.9 })]);
    expect(html).toContain("rsi14");
    expect(html).toContain("sma50");
    expect(html).toContain("Momentum");
    expect(html).toContain("Trend");
  });

  it("hatches BOTH bearish tones, never just the pole", () => {
    // bear (state -0.9) and bear-mid (state -0.3) must each carry the hatch:
    // bear/bull-mid fails at dE 2.8 for protanopes and bear-mid/bull-mid at
    // dE 3.1 for deuteranopes, so hatching only the pole silently
    // reintroduces both failures.
    const html = render([
      tile({ key: "a@1d", signal: "a", state: -0.9 }),
      tile({ key: "b@1d", signal: "b", state: -0.3 }),
    ]);
    expect(html.match(/url\(#map-hatch\)/g) ?? []).toHaveLength(2);
  });

  it("does not hatch bullish or neutral tiles", () => {
    const html = render([
      tile({ key: "a@1d", state: 0.9 }),
      tile({ key: "b@1d", state: 0.05 }),
    ]);
    expect(html).not.toContain("url(#map-hatch)");
  });

  it("draws an unfitted tile with a dashed outline", () => {
    // Before the first fit every multiplier is 1.0 and the map is a uniform
    // grid. Dashed is what stops that grid reading as a measurement.
    expect(render([tile({ fitted: false, multiplier: 1 })]))
      .toContain("stroke-dasharray");
  });

  it("draws a fitted tile solid", () => {
    expect(render([tile({ fitted: true })])).not.toContain("stroke-dasharray");
  });

  it("states each signal's read and multiplier in its hover title", () => {
    expect(render([tile()])).toContain("rsi14 1d");
    expect(render([tile()])).toContain("2.00");
  });

  it("shows an honest empty state with no tiles at all", () => {
    const html = render([]);
    expect(html).toContain("No technical signals");
    expect(html).not.toContain("<svg");
  });

  it("renders the hatch pattern definition in its own svg", () => {
    // A url(#map-hatch) reference into an SVG with no such pattern paints
    // nothing, silently removing the second encoding.
    expect(render([tile({ state: -0.9 })])).toContain('id="map-hatch"');
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd panel && npx vitest run test/technical-map.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 5: Implement `panel/components/technical-map.tsx`**

```tsx
import { fmtAge } from "@/lib/format";
import { toneFromIntensity } from "@/lib/marketmap";
import { layoutSignalMap, type SignalTile } from "@/lib/technicalmap";
import {
  MapHatchDefs, MapLegend, MapTile, LABEL_PAD, MIN_LABEL_H, MIN_LABEL_W,
  truncateForWidth, wrapForTile,
} from "@/components/map-tiles";
import { FullscreenButton } from "@/components/fullscreen-button";

/**
 * Technical market map: a two-level treemap of signal states, drawn as
 * server-rendered inline SVG for the same reasons as the fundamental map.
 *
 * AREA is the learned multiplier and nothing else — there is no tier for a
 * signal. So this map's shape barely changes between refreshes, which is
 * correct rather than stale: the multiplier says how much a signal has
 * historically mattered, and only the colour is today's read.
 *
 * COLOUR is the state itself, already in [-1, +1], on the same five-step
 * ramp as the fundamental map, with the same mandatory hatch on BOTH bearish
 * tones. See components/map-tiles.tsx for why both, and why the hatch is a
 * required second encoding rather than decoration.
 *
 * The confidence treatment finally does real work here: fitted weights render
 * solid, weights still at 1.0 for want of a sample render dashed. On day one
 * the map is largely solid, since Fit A learns from five years of backfill.
 */

const FAMILY_HEADER_H = 20;
const HEADER_FONT = 9;

export const TECHNICAL_MAP_ELEMENT_ID = "technical-map";

const FAMILY_LABELS: Record<string, string> = {
  trend: "Trend",
  momentum: "Momentum",
  levels: "Levels",
  volatility: "Volatility",
  positioning: "Positioning",
};

/** Unrecognised slugs degrade to a readable label rather than crashing. */
function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ??
    family.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function tileTitle(t: SignalTile, now: Date): string {
  const read = t.state > 0.15 ? "bullish" : t.state < -0.15 ? "bearish" : "neutral";
  const weight = t.fitted ? `weight ${t.multiplier.toFixed(2)}`
    : `weight ${t.multiplier.toFixed(2)} (not yet fitted)`;
  return `${t.signal} ${t.timeframe} — ${read} ${t.state.toFixed(2)}, `
    + `${weight}, ${fmtAge(t.ts, now)}`;
}

export function TechnicalMap({ tiles, width, height, fittedAt }: {
  tiles: SignalTile[];
  width: number;
  height: number;
  fittedAt: string | null;
}) {
  const now = new Date();

  if (tiles.length === 0) {
    return (
      <section aria-label="Technical signal treemap"
        className="rounded border border-border p-4">
        <p className="text-sm text-muted-foreground">
          No technical signals yet — run <code>jamasp bars backfill</code> and{" "}
          <code>jamasp signals refresh</code>.
        </p>
      </section>
    );
  }

  const boxes = layoutSignalMap(
    tiles, { x: 0, y: 0, w: width, h: height }, FAMILY_HEADER_H);
  const unfitted = tiles.filter(t => !t.fitted).length;

  return (
    <section id={TECHNICAL_MAP_ELEMENT_ID} aria-label="Technical signal treemap"
      className="rounded border border-border p-4 bg-background">
      <div className="mb-2 flex items-center justify-end">
        <FullscreenButton targetId={TECHNICAL_MAP_ELEMENT_ID} />
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img"
        aria-label={`technical signal treemap, ${tiles.length} signals`}>
        <MapHatchDefs />
        {boxes.map(box => (
          <g key={box.group}>
            <text x={box.x + LABEL_PAD} y={box.y + 13} fontSize={HEADER_FONT}
              fill="var(--muted-foreground)"
              style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {truncateForWidth(familyLabel(box.group), box.w, HEADER_FONT)}
            </text>
            {box.items.map(cell => {
              const showLabel = cell.w >= MIN_LABEL_W && cell.h >= MIN_LABEL_H;
              return (
                <MapTile key={cell.node.key}
                  x={cell.x} y={cell.y} w={cell.w} h={cell.h}
                  tone={toneFromIntensity(cell.node.state)}
                  title={tileTitle(cell.node, now)}
                  dashed={!cell.node.fitted}
                  lines={showLabel
                    ? wrapForTile(
                        `${cell.node.signal} ${cell.node.timeframe}`,
                        cell.w, cell.h)
                    : []} />
              );
            })}
          </g>
        ))}
      </svg>
      <MapLegend />
      <p className="mt-2 text-xs text-muted-foreground">
        {tiles.length} signals
        {unfitted > 0 ? ` · ${unfitted} not yet fitted (dashed)` : ""}
        {fittedAt ? ` · weights fitted ${fmtAge(fittedAt, now)}` : " · no fit yet"}
      </p>
    </section>
  );
}
```

- [ ] **Step 6: Run to verify the tests pass**

Run: `cd panel && npx vitest run test/technical-map.test.tsx`
Expected: PASS

- [ ] **Step 7: Wire it into the page**

In `panel/app/page.tsx`, add the imports and, in the server component body beside the existing map reads:

```tsx
  // --- technical map ---
  const signalStates = db.latestSignalStates();
  const fittedWeights = files.readFittedWeights();
  const signalTiles = buildSignalTiles(
    signalStates, files.loadWeightsConfig().signals, fittedWeights);
```

and render it directly after the existing `<section aria-label="Market map">`:

```tsx
      <section aria-label="Technical map" className="mb-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Technical map</h2>
        {/* Same 2:1 viewBox as the fundamental map. The SVG preserves its
            aspect ratio on purpose — stretching would distort tile areas, and
            area is the encoding on a treemap. */}
        <TechnicalMap tiles={signalTiles} width={1200} height={600}
          fittedAt={fittedWeights?.fittedAt ?? null} />
      </section>
```

- [ ] **Step 8: Extend the e2e fixture**

In `panel/scripts/build-fixture.mjs`, after the existing item/score inserts, add:

```js
// Technical map fixture. signal_states is created here rather than in
// fixture.sql because the panel's own missing-table guard is exercised by
// test/db-marketmap-no-table.test.ts; this file's job is the populated path.
db.exec(`CREATE TABLE IF NOT EXISTS signal_states (
  key TEXT NOT NULL, ts TEXT NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (key, ts))`);
const insertState = db.prepare(
  "INSERT INTO signal_states (key, ts, value) VALUES (?, ?, ?)");
// One bullish, one bearish (exercising the hatch path) and one unfitted
// (exercising the dashed path), across two families so the map has two boxes.
insertState.run("rsi14@1d", todayAt, -0.9);
insertState.run("sma50@1d", todayAt, 0.8);
insertState.run("macd@1d", todayAt, 0.4);

writeFileSync(path.join(root, "state", "weights.json"), JSON.stringify({
  fitted_at: todayAt,
  fits: {
    technical: {
      n: 16880, horizon_hours: 24, flags: [],
      coefficients: {
        "rsi14@1d": { beta: 0.03, se: 0.008, multiplier: 2.0,
                      observations: 900, fitted: true },
        "sma50@1d": { beta: 0.02, se: 0.009, multiplier: 1.2,
                      observations: 900, fitted: true },
        // macd@1d is deliberately absent: it must render dashed.
      },
    },
  },
}, null, 1));
```

Add `writeFileSync` to the `node:fs` import at the top of the file.

- [ ] **Step 9: Add the e2e spec**

Append to `panel/e2e/smoke.spec.ts`, following the file's existing spec idiom:

```ts
test("overview renders the technical map", async ({ page }) => {
  await page.goto("/");
  const map = page.getByRole("img", { name: /technical signal treemap/ });
  await expect(map).toBeVisible();
  // The fixture holds one bearish signal, so exactly one tile must carry the
  // hatch — the assertion that would fail if the extraction into
  // map-tiles.tsx dropped the hatch on the way past.
  await expect(map.locator('rect[fill="url(#map-hatch)"]')).toHaveCount(1);
  // macd@1d has no fitted coefficient, so its tile must be dashed.
  await expect(map.locator("rect[stroke-dasharray]")).toHaveCount(1);
});
```

- [ ] **Step 10: Run everything**

Run: `cd panel && npm test && npx tsc --noEmit && npm run fixture && npm run e2e && npm run build`
Expected: all PASS.

- [ ] **Step 11: Commit**

Stage `panel/components/map-tiles.tsx`, `panel/components/technical-map.tsx`, `panel/components/market-map.tsx`, `panel/app/page.tsx`, `panel/scripts/build-fixture.mjs`, `panel/e2e/smoke.spec.ts` and the test files, and commit with:

```
feat(panel): the technical map

Tile primitives move into map-tiles.tsx rather than being copied. The parts
that moved are correctness-bearing, not styling: the hatch that makes two
CVD-failing colour pairs separable, and the <title> that has to sit on the
group because the hatch overlay is the topmost hit target and would
otherwise swallow the tooltip on every bearish tile. A second copy would be
a second place for each to regress, and they are the parts nobody
re-derives when they regress.

Area is the learned multiplier alone, so this map's shape barely changes
between refreshes — correct, not stale. Unfitted weights render dashed,
which is what stops a pre-fit uniform grid reading as a measurement.
```

---

### Task 11: Panel — learned theme multipliers on the fundamental map

**Files:**
- Modify: `panel/lib/marketmap.ts` (`layoutMap` accepts theme multipliers)
- Modify: `panel/components/market-map.tsx` (accepts and forwards them; footer states the fit)
- Modify: `panel/app/page.tsx`
- Modify: `panel/test/marketmap.test.ts`, `panel/test/market-map.test.tsx`

**Interfaces:**
- Consumes: `readFittedWeights` (Task 9); `layoutGroups`, `tierWeight` (Task 9).
- Produces: `layoutMap(items, rect, headerHeight, multipliers?: Record<string, number>): ThemeBox[]` — the fourth parameter is optional and defaults to `{}`, so every existing call site keeps working unchanged. `MarketMap` gains `themeMultipliers?: Record<string, number>` and `fittedAt?: string | null`.

**This is what closes the loop.** Fit B produces theme multipliers and, until this task, nothing consumes them. A story's area becomes `tierWeight(tier) * multiplier(theme)` — which also scales its theme's box, since a box's value is the sum of its children's.

- [ ] **Step 1: Write the failing tests**

Append to `panel/test/marketmap.test.ts`:

```ts
describe("layoutMap with learned theme multipliers", () => {
  const rect = { x: 0, y: 0, w: 400, h: 300 };
  const item = (id: string, theme: string) => ({
    itemId: id, tier: 5, direction: 2, conviction: 0.8, theme,
    headline: "h", source: "s", url: `u${id}`,
    publishedAt: "2026-08-20T00:00:00Z",
  });

  it("scales a theme's area by its multiplier", () => {
    const items = [item("1", "rates_dollar"), item("2", "geopolitics")];
    const boxes = layoutMap(items, rect, 0, { rates_dollar: 3, geopolitics: 1 });
    const rates = boxes.find(b => b.theme === "rates_dollar")!;
    const geo = boxes.find(b => b.theme === "geopolitics")!;
    // Same tier, so the multiplier is the only thing separating them.
    expect((rates.w * rates.h) / (geo.w * geo.h)).toBeCloseTo(3, 2);
  });

  it("treats an absent multiplier as neutral", () => {
    // Before Fit B has enough rows there are no theme multipliers at all, and
    // the map must render exactly as it did before this feature existed.
    const items = [item("1", "rates_dollar"), item("2", "geopolitics")];
    const withNone = layoutMap(items, rect, 0);
    const withEmpty = layoutMap(items, rect, 0, {});
    expect(withEmpty).toEqual(withNone);
  });

  it("ignores a multiplier for a theme with no stories", () => {
    const boxes = layoutMap([item("1", "rates_dollar")], rect, 0,
      { rates_dollar: 2, etf_flows: 3 });
    expect(boxes.map(b => b.theme)).toEqual(["rates_dollar"]);
  });

  it("still fills the whole canvas", () => {
    const items = [item("1", "rates_dollar"), item("2", "geopolitics")];
    const boxes = layoutMap(items, rect, 0, { rates_dollar: 3, geopolitics: 1 });
    const total = boxes.reduce((s, b) => s + b.w * b.h, 0);
    // Ratio, not absolute area — see the technical map's equivalent test.
    expect(total / (400 * 300)).toBeCloseTo(1, 6);
  });
});
```

`panel/test/market-map.test.tsx` has a `const render = (items: ScoredItem[]) => renderToStaticMarkup(...)` helper at line 15 that every test in the file calls. Give it an optional second parameter and spread it onto `<MarketMap>`, so the ~12 existing single-argument call sites are untouched:

```tsx
const render = (
  items: ScoredItem[],
  extra: { themeMultipliers?: Record<string, number>;
           fittedAt?: string | null } = {},
) => renderToStaticMarkup(
  <MarketMap items={items} width={1200} height={600} range="today"
    coverage={{ scored: items.length, unscored: 0 }} {...extra} />);
```

Then append:

```tsx
it("states in the footer whether the areas are learned or provisional", () => {
  // A map that quietly rescaled itself the day a fit first succeeded, with
  // nothing on the page saying so, would be worse than one that reads
  // "provisional" for three weeks.
  expect(render([item()], { themeMultipliers: {}, fittedAt: null }))
    .toContain("weights not yet fitted");

  expect(render([item()], {
    themeMultipliers: { rates_dollar: 1.6 },
    fittedAt: "2026-08-20T04:17:00Z",
  })).not.toContain("weights not yet fitted");
});

it("defaults to the provisional footer when no weights are passed at all", () => {
  expect(render([item()])).toContain("weights not yet fitted");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd panel && npx vitest run test/marketmap.test.ts test/market-map.test.tsx`
Expected: FAIL — `layoutMap` takes three parameters.

- [ ] **Step 3: Apply the multipliers**

In `panel/lib/marketmap.ts`, replace `layoutMap` with:

```ts
/**
 * The fundamental map's layout: stories grouped by theme, sized by tier and
 * by the theme's learned multiplier.
 *
 * `multipliers` comes from Fit B via state/weights.json. An absent entry is
 * 1.0, so a deployment whose theme fit has not yet reached min_rows renders
 * exactly as it did before this existed — a map that quietly rescaled itself
 * on the day a fit first succeeded, with nothing on the page saying so, would
 * be a worse outcome than one that says "provisional" for three weeks.
 */
export function layoutMap(
  items: ScoredItem[], rect: Rect, headerHeight: number,
  multipliers: Record<string, number> = {},
): ThemeBox[] {
  const boxes = layoutGroups(
    items.map(it => ({
      group: it.theme,
      value: tierWeight(it.tier) * (multipliers[it.theme] ?? 1),
      node: it,
    })),
    rect, headerHeight);
  return boxes.map(b => ({
    x: b.x, y: b.y, w: b.w, h: b.h,
    theme: b.group, items: b.items, total: b.total,
  }));
}
```

- [ ] **Step 4: Forward them through the component**

In `panel/components/market-map.tsx`, add `themeMultipliers` and `fittedAt` to the props, pass `themeMultipliers` into `layoutMap`, and extend the coverage footer:

```tsx
      <p className="mt-2 text-xs text-muted-foreground">
        {coverage.scored} scored {coverage.scored === 1 ? "story" : "stories"} {WINDOW_LABEL[range]}
        {" "}· {coverage.unscored} unscored not shown
        {fittedAt
          ? ` · areas weighted by the ${fmtAge(fittedAt, now)} fit`
          : " · weights not yet fitted"}
      </p>
```

- [ ] **Step 5: Wire the page**

In `panel/app/page.tsx`, derive the theme multipliers from the weights already read in Task 10 and pass them down:

```tsx
  const themeMultipliers = Object.fromEntries(
    Object.entries(fittedWeights?.fits?.theme?.coefficients ?? {})
      .filter(([, c]) => c.fitted)
      .map(([key, c]) => [key, c.multiplier]));
```

```tsx
        <MarketMap items={mapItems} width={1200} height={600} range={range}
          coverage={{ scored: mapItems.length, unscored: mapUnscored }}
          themeMultipliers={themeMultipliers}
          fittedAt={fittedWeights?.fittedAt ?? null} />
```

Note the `.filter(([, c]) => c.fitted)`: an unfitted theme coefficient must not resize a tile, for the same reason an unfitted signal weighs neutral on the technical map.

- [ ] **Step 6: Run everything**

Run: `cd panel && npm test && npx tsc --noEmit && npm run fixture && npm run e2e && npm run build`
Expected: all PASS.

- [ ] **Step 7: Run the Python suite too**

Run: `uv run pytest -q`
Expected: PASS

- [ ] **Step 8: Commit**

Stage `panel/lib/marketmap.ts`, `panel/components/market-map.tsx`, `panel/app/page.tsx` and the two test files, and commit with:

```
feat(panel): learned theme multipliers on the fundamental map

This closes the loop: Fit B has produced theme multipliers since the last
task and nothing consumed them. A story's area is now tierWeight(tier)
times its theme's multiplier, which also scales the theme's box since a
box's value is the sum of its children's.

An absent multiplier is 1.0, so a deployment whose theme fit has not
reached min_rows renders exactly as before. The footer says which it is: a
map that quietly rescaled itself the day a fit first succeeded, with
nothing on the page saying so, would be worse than one that reads
"provisional" for three weeks.

Unfitted theme coefficients are filtered out at the page, for the same
reason an unfitted signal weighs neutral on the technical map.
```

---

## Done when

- `uv run pytest -q` passes.
- `cd panel && npm test` passes, `npx tsc --noEmit` is clean, `npm run e2e` passes (vitest excludes `e2e/**`, so it cannot see page-level regressions on its own), and `npm run build` succeeds.
- `uv run jamasp bars backfill` writes roughly 17k hourly, 4.3k 4h, 1.25k daily and 260 weekly bars.
- `uv run jamasp signals refresh` writes 36 states (12 signals × 3 timeframes; GVZ and net spec appear too once their `prices` series have 50 observations).
- `uv run jamasp weights fit` produces `state/weights.json` with a `technical` fit and, once ~2 weeks of scored news exist, a `theme` fit.
- Both maps render on `/` — the technical one largely solid on day one, since Fit A learns from five years of backfill.

## Deliberately out of scope

- **Live weekly/4h values from TradingView.** `docs/todo/003` stands. The technical map's values for those timeframes come from the same computed path as the fit until that question is settled.
- **The `item_scores` coverage ceiling.** The fit sees whatever the triage classified; items that arrived outside `flash.max_age_hours` are unscored and simply absent.
- **Any aggregate buy/sell verdict**, on either map. `config/sources.yaml:326` stands.
- **Multi-horizon weight sets.** One `H`, retro-tunable.
- **A retro workflow for reading the fit.** The `weight_fits` trajectory and the `negative:` flags exist for the retro to consume; teaching `/retro` to read them is its own change.
