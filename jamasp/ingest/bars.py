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
