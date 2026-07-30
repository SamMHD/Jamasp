"""Price snapshot fetchers: Stooq CSV and FRED CSV."""
from __future__ import annotations

import csv
import io
import sqlite3

import httpx

from jamasp.config import Source

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


PARSERS["stooq_csv"] = parse_stooq_csv
PARSERS["fred_csv"] = parse_fred_csv


def fetch_price(source: Source, client: httpx.Client) -> tuple[str, str, float]:
    resp = client.get(source.url, follow_redirects=True, timeout=30)
    resp.raise_for_status()
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
