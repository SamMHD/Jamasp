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


class BackfillResult(NamedTuple):
    """What landed, and what didn't.

    Returned rather than raised because a partial backfill is a NORMAL
    outcome, not an error: one endpoint being unavailable must not stop the
    pipeline standing behind this one. The caller decides what a given
    combination means — `jamasp bars backfill` exits 0 whenever anything was
    written and non-zero only on total darkness.
    """

    written: dict[str, int]      # timeframe -> rows written
    failures: dict[str, str]     # leg ("1h"/"1d") -> every provider's error
    sources: dict[str, str]      # timeframe -> the provider that served it


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

# Provenance. `bars` carries one of these per row, and a timeframe is served
# by exactly ONE of them at a time — see store_bars for why mixing is unsafe.
SOURCE_YAHOO = "yahoo"
SOURCE_BITFINEX = "bitfinex"

# --- primary: Yahoo, COMEX gold futures (GC=F) ----------------------------
#
# The same host and endpoint gold_spot already polls (config/sources.yaml:224),
# at the two depths Yahoo actually serves: interval=1h is capped at range=730d,
# interval=1d reaches five years. Measured 2026-08-18: 17,395 hourly bars.
#
# Both of these are refused with 429 from the production egress and have been
# since 2026-08-24 (docs/todo/012). They stay PRIMARY anyway: GC=F is the
# instrument the desk actually trades, the block may lift, and the fallback
# below is a proxy rather than the real thing.
HOURLY_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/GC=F"
    "?range=730d&interval=1h"
)
DAILY_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/GC=F"
    "?range=5y&interval=1d"
)

# --- fallback: Bitfinex, Tether Gold (XAUT/USD) ---------------------------
#
# WHAT THIS IS, stated plainly because it is not GC=F: XAUT is a token
# redeemable for one troy ounce of LBMA Good Delivery gold, so XAUT/USD is a
# SPOT gold price. GC=F is a futures price on the same metal, and it trades
# above spot by the cost of carry.
#
# Measured against this repo's own `prices` GC=F history, 31 overlapping
# sessions 2026-07-31..2026-09-04:
#
#     XAUT/GC ratio   mean 0.98524   sd 0.00250   max deviation 1.89%
#     daily-return correlation                      0.9951
#
# So it sits ~1.5% below GC=F, steadily, and moves with it almost exactly.
# That is the futures basis, not a different market.
#
# Why a ~1.5% level offset is acceptable HERE specifically: every consumer of
# this table is scale-invariant or a ratio of scale-equivariant quantities.
# The twelve classifiers in signals.py read RSI/Stochastic/Williams %R/ADX
# (pure ratios), or (close - level) / ATR, or a position within a band — a
# constant multiplicative offset cancels in all of them. features.py's fit
# target is (forward close - close) / ATR14, where it cancels again. Nothing
# reads a bar close as a gold price: the panel and the brief quote `prices`,
# which is still real GC=F from the working 15-minute poll. Verified by
# grep — the only readers of `bars` are signals.py, features.py and
# watchdog.py's freshness check.
#
# Chosen over the alternatives that were also measured from the host:
#   Kraken PAXG/USD  ratio 0.98681, corr 0.9957, but only 720 daily candles
#                    (~2y) and no deep hourly — cannot feed the fit's target.
#   GLD via stockanalysis.com  corr 0.9683 (NYSE hours only, so it misses the
#                    overnight session that moves gold) and needs an ~11x
#                    scale factor that drifts with the fund's expense ratio.
# Stooq, Barchart, Dukascopy, investing.com, MarketWatch, WSJ, CNBC and
# Nasdaq were all tried and are blocked, walled or key-only — see docs/todo/012.
#
# Keyless, no account, 30 req/min public limit; we make at most two per day.
# limit=10000 is the API maximum and sort=-1 asks for the NEWEST page, which
# is the only way to reach current data — sort=1 returns the oldest 10,000
# and would hand back 2020. Measured 2026-09-05: 10,000 hourly candles
# (~15 months, 7,618 after the weekend filter) and 2,416 daily (back to
# 2020-01-24, 1,726 after the filter) — deeper than Yahoo's 5-year daily leg.
_BITFINEX = "https://api-pub.bitfinex.com/v2/candles/trade:{tf}:tXAUT:USD/hist"
BITFINEX_HOURLY_URL = _BITFINEX.format(tf="1h") + "?limit=10000&sort=-1"
BITFINEX_DAILY_URL = _BITFINEX.format(tf="1D") + "?limit=10000&sort=-1"


def parse_bitfinex_candles(text: str) -> list[Bar]:
    """Bitfinex v2 candle JSON -> bars, oldest first.

    The row shape is [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME] — close is the
    SECOND field, not the fourth. Reading it as OHLC would swap close with
    high and low with close on every bar, which ATR and every level signal
    would consume without complaint.

    `MTS` is milliseconds and is the bar's OPEN time, matching `ts`.
    """
    rows = json.loads(text)
    out = [
        Bar(_fmt(int(ts // 1000)), float(o), float(h), float(low), float(c))
        for ts, o, c, h, low, *_ in rows
        if None not in (o, c, h, low)
    ]
    if not out:
        raise ValueError("no complete OHLC bars in bitfinex candle json")
    # sort=-1 gives newest first; every indicator downstream is order-dependent.
    return sorted(out, key=lambda b: b.ts)


def comex_sessions_only(bars: list[Bar]) -> list[Bar]:
    """Drop bars struck while COMEX gold was shut.

    XAUT trades continuously; GC=F does not. Keeping weekend bars would make
    a "200-day" SMA span roughly 143 trading days, and would let the thin,
    wide-spread weekend book into ATR and into the highs and lows every level
    signal reads. Filtering here keeps the fallback series the same SHAPE as
    the Yahoo series it stands in for, so switching sources changes the level
    by the basis and nothing else.

    CME Globex runs Sunday 22:00 UTC to Friday 21:00 UTC (US Eastern summer
    time), so Saturday is closed outright and Sunday is closed until 22:00.
    Under US winter time the reopen is 23:00 UTC, so one Sunday bar a week is
    kept that Yahoo would not have had; that is the same order of
    approximation as resample_weekly's Monday-UTC week boundary, and for the
    same reason — a consistent rule beats an exact one nobody can verify.
    """
    out = []
    for b in bars:
        d = datetime.strptime(b.ts, TS_FMT).replace(tzinfo=timezone.utc)
        if d.weekday() == 5:                      # Saturday: shut all day
            continue
        if d.weekday() == 6 and d.hour < 22:      # Sunday, before the reopen
            continue
        out.append(b)
    return out


def _bitfinex_bars(text: str) -> list[Bar]:
    return comex_sessions_only(parse_bitfinex_candles(text))


# Ordered provider chain per leg: (source, url, parser). First one that
# returns bars wins; the rest are not called.
HOURLY_PROVIDERS = (
    (SOURCE_YAHOO, HOURLY_URL, parse_yahoo_bars),
    (SOURCE_BITFINEX, BITFINEX_HOURLY_URL, _bitfinex_bars),
)
DAILY_PROVIDERS = (
    (SOURCE_YAHOO, DAILY_URL, parse_yahoo_bars),
    (SOURCE_BITFINEX, BITFINEX_DAILY_URL, _bitfinex_bars),
)


def store_bars(
    conn: sqlite3.Connection, symbol: str, timeframe: str, bars: list[Bar],
    source: str,
) -> int:
    """Upsert bars from `source`. Returns the number of rows written.

    `source` is required rather than defaulted because a mislabelled row is
    exactly the failure this column exists to prevent.

    ONE TIMEFRAME, ONE SOURCE. The first statement evicts any rows in this
    timeframe written by a different provider. Yahoo stamps GC=F daily bars
    at the session open and Bitfinex stamps XAUT at 00:00 UTC, so the same
    trading day lands under two different keys; and the two series sit ~1.5%
    apart (the futures basis). Left to accumulate, that would put duplicate
    days in the series and a 1.5% cliff in the middle of it, which every
    indicator would read as a genuine overnight gap rather than a change of
    vendor. Wholesale eviction on a provider change is the only way to keep
    the series internally consistent.

    In the steady state — the same provider serving the same timeframe every
    day — that DELETE matches zero rows and touches nothing, so it costs
    neither a page rewrite nor a git diff (see below).

    ON CONFLICT DO UPDATE rather than INSERT OR REPLACE: `bars` is a rowid
    table, and REPLACE is a delete+insert under the hood — even a
    byte-identical row gets a fresh rowid, which rewrites every b-tree page
    it touches for zero information. `backfill` re-walks all history on
    every run by design (it is both the initial backfill and the daily
    refresh), and `state/jamasp.db` is git-tracked and committed at the end
    of every run (CLAUDE.md hard rule 4) — so a delete+insert here means
    megabytes of new, immutable git objects every day forever for rows that
    did not change. Updating in place touches no row, and so no page, unless
    a value actually differs.

    An UPDATE still runs on every conflict, unconditionally, rather than
    only when a value differs: Yahoo revises the most recent bar while it is
    still forming, and a stored copy frozen at the first value seen would
    quietly disagree with every later fetch. What changes is that the update
    happens IN PLACE at the row's existing rowid, rather than deleting and
    reinserting it — so when the incoming values equal the stored ones (the
    common case on every backfill after the first), the row's page comes out
    byte-identical to what was already committed, and git sees no diff.
    REPLACE cannot do that: a new rowid every time means a rewritten page
    every time, whether or not anything actually changed.
    """
    conn.execute(
        "DELETE FROM bars WHERE symbol = ? AND timeframe = ? AND source <> ?",
        (symbol, timeframe, source),
    )
    conn.executemany(
        "INSERT INTO bars (symbol, timeframe, ts, open, high, low, close, source)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET"
        " open = excluded.open, high = excluded.high,"
        " low = excluded.low, close = excluded.close, source = excluded.source",
        [(symbol, timeframe, b.ts, b.open, b.high, b.low, b.close, source)
         for b in bars],
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


class _LegDark(Exception):
    """Every provider for one leg refused. Carries all their errors."""


def _fetch_leg(fetch, providers) -> tuple[str, list[Bar]]:
    """First provider that returns bars wins; later ones are never called.

    Raises _LegDark naming every provider that refused, so the journal line
    distinguishes "Yahoo is blocked again" from "the whole internet is gone".
    """
    errors: list[str] = []
    for source, url, parse in providers:
        try:
            return source, parse(fetch(url))
        except Exception as exc:  # noqa: BLE001 - collected, not swallowed
            errors.append(f"{source}: {type(exc).__name__}: {exc}")
    raise _LegDark("; ".join(errors))


def backfill(
    conn: sqlite3.Connection, symbol: str = SYMBOL, fetch=None
) -> BackfillResult:
    """Fetch and store every timeframe. Returns timeframe -> rows written.

    Idempotent on the primary key, which makes one command serve as both the
    initial backfill AND the daily refresh: the two calls re-walk overlapping
    history and upsert, so no separate incremental path exists to drift out
    of agreement with this one.

    Each timeframe is committed as it is derived, before the next fetch, and
    the two endpoints are independent in BOTH directions: a daily-endpoint
    failure must not cost the 730-day hourly pull that already succeeded, and
    an hourly failure must not cost the daily pull that would have worked.

    That symmetry is not hypothetical. Yahoo serves
    `range=1d&interval=1h` (what `gold_spot` polls every 15 minutes) while
    429ing `range=730d&interval=1h`, so from 2026-08-24 the hourly leg failed
    every single day. Aborting there took the 5-year daily pull with it:
    `bars` stayed empty, so `signals refresh` had nothing to compute from and
    the ridge fits never saw a row.

    Never raises for a leg failure — it reports one. Deciding that a dead
    hourly endpoint should abort the daily pull, `signals refresh` and the
    ridge fits is not this function's call to make, and making it here is
    precisely what kept `bars` empty for twelve days.
    """
    fetch = fetch or _default_fetch
    written: dict[str, int] = {}
    failures: dict[str, str] = {}
    sources: dict[str, str] = {}

    try:
        source, hourly = _fetch_leg(fetch, HOURLY_PROVIDERS)
        written["1h"] = store_bars(conn, symbol, "1h", hourly, source)
        written["4h"] = store_bars(
            conn, symbol, "4h", resample(hourly, 4 * 3600), source)
        sources["1h"] = sources["4h"] = source
    except _LegDark as exc:
        failures["1h"] = str(exc)

    try:
        source, daily = _fetch_leg(fetch, DAILY_PROVIDERS)
        written["1d"] = store_bars(conn, symbol, "1d", daily, source)
        written["1w"] = store_bars(
            conn, symbol, "1w", resample_weekly(daily), source)
        sources["1d"] = sources["1w"] = source
    except _LegDark as exc:
        failures["1d"] = str(exc)

    return BackfillResult(written, failures, sources)


TIMEFRAME_SECONDS = {"1h": 3600, "4h": 4 * 3600, "1d": 86400, "1w": 7 * 86400}


def close_ts(ts: str, timeframe: str) -> str:
    """The moment a bar opening at `ts` finished forming.

    The separation between a bar's open and its close is the whole
    no-lookahead guarantee: a state derived from a daily bar is not knowable
    until that day ends, so anything reading states as of some instant `t`
    must compare against this, never against the stored `ts`.
    """
    return _fmt(_epoch(ts) + TIMEFRAME_SECONDS[timeframe])
