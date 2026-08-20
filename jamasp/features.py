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

    O(log m) via bisect's `key`, not O(m): `_feature_block` calls this once
    per row per column, so rebuilding a fresh m-length timestamp list on
    every call (as an earlier version of this function did) turned a
    38-column, thousands-of-rows matrix build into O(rows * sum(m)) element
    operations -- minutes against a systemd unit's timeout. `key` lets
    bisect compare `ts` against each element's own timestamp in place,
    without ever materialising that list.
    """
    i = bisect.bisect_right(history, ts, key=lambda h: h[0])
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
