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
    # ATR's own warm-up leaves a None prefix. Padding those with 0.0 before
    # averaging would treat "not yet measured" as "measured at zero
    # volatility" and drag the rolling average down for the next 49 bars,
    # fabricating a volatility-expansion read where none occurred. Average
    # over the real values only and re-offset, exactly as indicators.macd
    # and indicators.stochastic do for their own post-warm-up derivatives.
    live_atrs = [a for a in atrs if a is not None]
    avg_live = ind.sma(live_atrs, AVG_WINDOW)
    atr_avg: list[float | None] = [None] * len(atrs)
    offset = len(atrs) - len(live_atrs)
    for i, v in enumerate(avg_live):
        atr_avg[offset + i] = v
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


# Classifier context key -> the `prices` symbol suffix TradingView already
# stores for it (jamasp/ingest/prices.py#_TV_BASE writes these every ingest
# tick as GC_CLOSE, GC_RSI14, ...).
#
# fib618 and fib50 are deliberately ABSENT. TradingView serves
# Pivot.M.Fibonacci.S1/R1, stored as FIB_S1/FIB_R1 — those are Fibonacci
# PIVOT levels, a different quantity from indicators.fib_levels' 0.618/0.5
# retracements of a lookback range. They are the closest-looking numbers in
# the payload and the wrong ones; supplying them here would put a plausible
# state on a tile that means something else. Leaving them out lets _need()
# return None and the tile simply not appear, which is the honest outcome.
TV_PRICE_SUFFIXES = {
    "close": "CLOSE",
    "rsi14": "RSI14",
    "stoch_k": "STOCH_K",
    "stoch_d": "STOCH_D",
    "willr": "WILLR",
    "macd": "MACD",
    "macd_signal": "MACD_SIG",
    "adx": "ADX",
    "sma50": "SMA50",
    "sma200": "SMA200",
    "bb_upper": "BB_UPPER",
    "bb_lower": "BB_LOWER",
    "atr14": "ATR14",
    "pivot_r1": "PIV_R1",
    "pivot_s1": "PIV_S1",
}

# Provenance recorded on each signal_states row.
#
#   bars        computed from our own OHLC bars by indicators.py — the path
#               the TradingView oracle test cross-checks.
#   series      read from an external scalar series in `prices` (GVZ, CFTC
#               net spec). This is those signals' NORMAL path, not a
#               fallback; they never had bars to compute from.
#   tradingview read straight off TradingView's precomputed daily values,
#               because this host has no bars for that timeframe.
SOURCE_BARS = "bars"
SOURCE_SERIES = "series"
SOURCE_TV = "tradingview"


def tv_fallback_ctx(
    conn: sqlite3.Connection, symbol: str = "GC"
) -> tuple[str, dict] | None:
    """Latest TradingView indicator values as a classifier context.

    Returns (observed_at, ctx), or None when nothing is stored.

    This is a DISPLAY path, not a fit path. `signal_states` is documented as
    display-only — the fit recomputes every historical state from bars — so a
    row sourced here cannot reach the regression. That separation is the whole
    reason this is safe rather than a shortcut: TradingView gives us a current
    level, never the history the fit needs.

    Only the daily set exists to read: docs/todo/003 records that TradingView's
    |1W and |240 fields come back null for COMEX:GC1!, so nothing else is
    stored to fall back on.
    """
    ctx: dict = {}
    stamps: list[str] = []
    for key, suffix in TV_PRICE_SUFFIXES.items():
        row = conn.execute(
            "SELECT ts, value FROM prices WHERE symbol = ?"
            " ORDER BY ts DESC LIMIT 1",
            (f"{symbol}_{suffix}",),
        ).fetchone()
        if row is None:
            continue
        ctx[key] = row["value"]
        stamps.append(row["ts"])

    if not stamps:
        return None

    # The atr14 classifier wants a rolling average as well as a level. ATR's
    # own stored history is the series to take it from — the same AVG_WINDOW
    # the bar path uses, so the two paths agree on what "expansion" means.
    atrs = [
        r["value"]
        for r in conn.execute(
            "SELECT value FROM prices WHERE symbol = ? ORDER BY ts",
            (f"{symbol}_{TV_PRICE_SUFFIXES['atr14']}",),
        )
    ]
    avg = ind.sma(atrs, AVG_WINDOW)
    ctx["atr14_avg"] = avg[-1] if avg else None

    return max(stamps), ctx


def refresh(conn: sqlite3.Connection, weights: dict, symbol: str = "GC") -> int:
    """Recompute the latest state for every configured signal column.

    Only the most recent state per key is written. The fit does not read this
    table — it recomputes history from bars — so this exists purely so the
    panel can render a colour without porting the classifiers to TypeScript,
    which is a duplicate nobody could keep honest.
    """
    written = 0
    tv: tuple[str, dict] | None = None  # resolved lazily, at most once
    for spec in signal_specs(weights):
        for tf in spec.timeframes:
            source = SOURCE_BARS
            if spec.source == "bars":
                bars = read_bars(conn, symbol, tf)
                if bars:
                    states = bar_states(spec.name, bars, tf)
                elif tf == "1d":
                    # No bars for this timeframe. TradingView's stored daily
                    # values can still say what the signal reads right now,
                    # which is all the map's colour needs. Bars stay the
                    # preferred path whenever they exist: they are ours,
                    # oracle-checkable, and cover every timeframe.
                    if tv is None:
                        tv = tv_fallback_ctx(conn, symbol)
                    if tv is None:
                        continue
                    observed_at, ctx = tv
                    state = classify(spec.name, ctx)
                    if state is None:
                        continue  # e.g. fib618/fib50 — no TradingView equivalent
                    states = [(observed_at, state)]
                    source = SOURCE_TV
                else:
                    continue
            else:
                points = [
                    (r["ts"], r["value"])
                    for r in conn.execute(
                        "SELECT ts, value FROM prices WHERE symbol = ? ORDER BY ts",
                        (spec.symbol,),
                    )
                ]
                states = series_states(spec.name, points)
                source = SOURCE_SERIES
            if not states:
                continue
            ts, value = states[-1]
            conn.execute(
                "INSERT OR REPLACE INTO signal_states (key, ts, value, source)"
                " VALUES (?, ?, ?, ?)",
                (f"{spec.name}@{tf}", ts, value, source),
            )
            written += 1
    conn.commit()
    return written
