"""Price snapshot fetchers: Stooq CSV, FRED CSV, Yahoo Finance chart JSON."""
from __future__ import annotations

import csv
import io
import json
import sqlite3
from datetime import datetime, timezone

import httpx

from jamasp.config import Source
from jamasp.net import get_with_fallback

PARSERS = {}


def parse_stooq_csv(text: str) -> tuple[str, str, float]:
    row = next(csv.DictReader(io.StringIO(text)))
    ts = f"{row['Date']}T{row['Time']}Z"
    return row["Symbol"].upper(), ts, float(row["Close"])


def parse_fred_csv(text: str) -> tuple[str, str, float]:
    reader = csv.reader(io.StringIO(text))
    header = next(reader)
    series = header[1]
    last = None
    for date, value in reader:
        if value.strip() and value.strip() != ".":
            last = (date, float(value))
    if last is None:
        raise ValueError(f"no observations in FRED csv for {series}")
    return series, f"{last[0]}T00:00:00Z", last[1]


def parse_yahoo_chart_json(text: str) -> tuple[str, str, float]:
    result = json.loads(text)["chart"]["result"][0]
    symbol = result["meta"]["symbol"].upper()
    for suffix in ("=X", "=F"):
        if symbol.endswith(suffix):
            symbol = symbol[: -len(suffix)]
            break
    timestamps = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]
    for ts, close in zip(reversed(timestamps), reversed(closes)):
        if close is not None:
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            return symbol, dt.strftime("%Y-%m-%dT%H:%M:%SZ"), float(close)
    raise ValueError(f"no non-null closes in yahoo chart json for {symbol}")


def _parse_lbma_json(text: str, symbol: str, auction_utc: str) -> tuple[str, str, float]:
    # LBMA serves the full auction history (records like
    # {"d": "2026-07-30", "v": [usd, gbp, eur]}); today's record can exist
    # with null prices before the auction settles, so walk back to the
    # latest non-null USD value.
    records = json.loads(text)
    for rec in sorted(records, key=lambda r: r["d"], reverse=True):
        v = rec.get("v") or []
        if v and v[0]:
            return symbol, f"{rec['d']}T{auction_utc}Z", float(v[0])
    raise ValueError(f"no non-null USD price in LBMA json for {symbol}")


def parse_lbma_am_json(text: str) -> tuple[str, str, float]:
    return _parse_lbma_json(text, "XAU_AM", "10:30:00")


def parse_lbma_pm_json(text: str) -> tuple[str, str, float]:
    return _parse_lbma_json(text, "XAU_PM", "15:00:00")


def parse_cftc_cot_json(text: str) -> tuple[str, str, float]:
    records = json.loads(text)
    if not records:
        raise ValueError("empty CFTC COT response")
    rec = records[0]
    market = rec.get("market_and_exchange_names", "")
    # A commodity_name=GOLD query also matches MICRO GOLD et al.; refuse
    # anything but the main 100-oz COMEX contract rather than store wrong
    # positioning numbers.
    if not market.startswith("GOLD - COMMODITY EXCHANGE"):
        raise ValueError(f"unexpected COT contract: {market!r}")
    net = float(rec["noncomm_positions_long_all"]) - float(
        rec["noncomm_positions_short_all"]
    )
    ts = f"{rec['report_date_as_yyyy_mm_dd'][:10]}T00:00:00Z"
    return "GC_NET_SPEC", ts, net


def parse_sge_json(text: str) -> tuple[str, str, float]:
    # SGE daily benchmark (Au99.99, CNY/gram): {"zp": [[epoch_ms, price], …]}.
    # Walk back to the latest non-null price.
    points = json.loads(text)["zp"]
    for ts_ms, price in sorted(points, key=lambda p: p[0], reverse=True):
        if price is not None:
            dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
            return "SGE_AU_CNY_G", dt.strftime("%Y-%m-%dT%H:%M:%SZ"), float(price)
    raise ValueError("no non-null price in SGE benchmark json")


# TradingView scanner fields -> series-name suffixes (daily timeframe;
# pivots are TradingView's monthly Classic set). Recommend.All — the
# aggregate buy/sell gauge — is deliberately absent: technicals annotate
# the macro read, they must not originate calls.
TV_FIELD_SUFFIXES = {
    "RSI": "RSI14",
    "SMA50": "SMA50",
    "SMA200": "SMA200",
    "ATR": "ATR14",
    "Pivot.M.Classic.S1": "PIV_S1",
    "Pivot.M.Classic.R1": "PIV_R1",
}


def parse_tradingview_scanner_json(text: str) -> list[tuple[str, float]]:
    # Fields can be null when the market is closed mid-roll; skip those
    # rather than store garbage.
    data = json.loads(text)
    out = [
        (suffix, float(data[field]))
        for field, suffix in TV_FIELD_SUFFIXES.items()
        if data.get(field) is not None
    ]
    if not out:
        raise ValueError("no technical fields in tradingview scanner json")
    return out


TECH_PARSERS = {"tradingview_scanner_json": parse_tradingview_scanner_json}


def fetch_technicals(source: Source, client: httpx.Client) -> list[tuple[str, str, float]]:
    """One technicals fetch -> several (symbol, ts, value) rows, e.g. GC_RSI14."""
    if not source.symbol:
        raise ValueError(f"technicals source {source.name} needs a symbol prefix")
    resp = get_with_fallback(source.url, client)
    # The scanner payload carries no timestamp; stamp with fetch time.
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return [
        (f"{source.symbol}_{suffix}", ts, value)
        for suffix, value in TECH_PARSERS[source.parser](resp.text)
    ]


PARSERS["stooq_csv"] = parse_stooq_csv
PARSERS["fred_csv"] = parse_fred_csv
PARSERS["yahoo_chart_json"] = parse_yahoo_chart_json
PARSERS["lbma_am_json"] = parse_lbma_am_json
PARSERS["lbma_pm_json"] = parse_lbma_pm_json
PARSERS["cftc_cot_json"] = parse_cftc_cot_json
PARSERS["sge_json"] = parse_sge_json


def fetch_price(source: Source, client: httpx.Client) -> tuple[str, str, float]:
    resp = get_with_fallback(source.url, client)
    symbol, ts, value = PARSERS[source.parser](resp.text)
    return source.symbol or symbol, ts, value


def store_price(conn: sqlite3.Connection, symbol: str, ts: str, value: float) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO prices (symbol, ts, value) VALUES (?, ?, ?)",
        (symbol, ts, value),
    )
    conn.commit()


def latest(conn: sqlite3.Connection, symbol: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT ts, value FROM prices WHERE symbol = ? ORDER BY ts DESC LIMIT 1",
        (symbol,),
    ).fetchone()


def value_at_or_before(conn: sqlite3.Connection, symbol: str, ts: str) -> float | None:
    row = conn.execute(
        "SELECT value FROM prices WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1",
        (symbol, ts),
    ).fetchone()
    return row["value"] if row else None


def row_at_or_before(conn: sqlite3.Connection, symbol: str, ts: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT ts, value FROM prices WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1",
        (symbol, ts),
    ).fetchone()


def window_extremes(
    conn: sqlite3.Connection, symbol: str, start: str, end: str
) -> dict:
    """Highest and lowest print in [start, end], with when each happened.

    A level claim is settled by the extremes of its window, not by its
    endpoints: an overnight touch that mean-reverts before the next run is
    invisible to price_then/price_now but decides the claim.
    """
    hi = conn.execute(
        "SELECT ts, value FROM prices WHERE symbol = ? AND ts >= ? AND ts <= ?"
        " ORDER BY value DESC, ts LIMIT 1",
        (symbol, start, end),
    ).fetchone()
    lo = conn.execute(
        "SELECT ts, value FROM prices WHERE symbol = ? AND ts >= ? AND ts <= ?"
        " ORDER BY value ASC, ts LIMIT 1",
        (symbol, start, end),
    ).fetchone()
    return {
        "high": hi["value"] if hi else None,
        "high_ts": hi["ts"] if hi else None,
        "low": lo["value"] if lo else None,
        "low_ts": lo["ts"] if lo else None,
    }
