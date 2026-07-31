"""Compact price summary for agent briefs."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from jamasp.db import utcnow
from jamasp.ingest import prices


def _shift(now: str, hours: int) -> str:
    dt = datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (dt - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _delta(
    conn: sqlite3.Connection, symbol: str, current: float, ref_ts: str, latest_ts: str
) -> str:
    old_row = prices.row_at_or_before(conn, symbol, ref_ts)
    # No snapshot at/before ref_ts, or the only one we found is the same
    # observation as the latest row (FRED-style series lag) -> nothing to
    # compare against, so don't fabricate a "+0.00%" delta.
    if old_row is None or old_row["ts"] >= latest_ts:
        return "n/a"
    old = old_row["value"]
    if old == 0:
        return "n/a"
    pct = (current - old) / old * 100
    return f"{pct:+.2f}%"


def render(conn: sqlite3.Connection, now: str | None = None) -> str:
    now = now or utcnow()
    symbols = [
        r["symbol"]
        for r in conn.execute("SELECT DISTINCT symbol FROM prices ORDER BY symbol")
    ]
    if not symbols:
        return "no price data"
    lines = []
    for symbol in symbols:
        row = prices.latest(conn, symbol)
        value = row["value"]
        date = row["ts"][:10]
        lines.append(
            f"{symbol} {value:g} @{date} "
            f"(24h: {_delta(conn, symbol, value, _shift(now, 24), row['ts'])}, "
            f"7d: {_delta(conn, symbol, value, _shift(now, 24 * 7), row['ts'])})"
        )
    return "\n".join(lines)
