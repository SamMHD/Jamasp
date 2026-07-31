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


PARSERS["stooq_csv"] = parse_stooq_csv
PARSERS["fred_csv"] = parse_fred_csv
PARSERS["yahoo_chart_json"] = parse_yahoo_chart_json


def fetch_price(source: Source, client: httpx.Client) -> tuple[str, str, float]:
    resp = get_with_fallback(source.url, client)
    return PARSERS[source.parser](resp.text)


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
