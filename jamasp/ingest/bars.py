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


TIMEFRAME_SECONDS = {"1h": 3600, "4h": 4 * 3600, "1d": 86400, "1w": 7 * 86400}


def close_ts(ts: str, timeframe: str) -> str:
    """The moment a bar opening at `ts` finished forming.

    The separation between a bar's open and its close is the whole
    no-lookahead guarantee: a state derived from a daily bar is not knowable
    until that day ends, so anything reading states as of some instant `t`
    must compare against this, never against the stored `ts`.
    """
    return _fmt(_epoch(ts) + TIMEFRAME_SECONDS[timeframe])
