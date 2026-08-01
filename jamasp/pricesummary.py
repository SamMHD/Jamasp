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


# Technical-context series (TradingView scanner source) collapse into one
# compact line per instrument; 24h/7d deltas on an RSI or a pivot are noise.
TECH_SUFFIXES = ("RSI14", "SMA50", "SMA200", "ATR14", "PIV_S1", "PIV_R1")


def _tech_split(symbol: str) -> tuple[str, str] | None:
    for suffix in TECH_SUFFIXES:
        if symbol.endswith("_" + suffix):
            return symbol[: -len(suffix) - 1], suffix
    return None


def _tech_line(conn: sqlite3.Connection, prefix: str, vals: dict[str, sqlite3.Row]) -> str:
    def v(suffix: str) -> float | None:
        row = vals.get(suffix)
        return row["value"] if row else None

    parts = []
    for suffix, label in (("RSI14", "RSI14"), ("ATR14", "ATR14"),
                          ("SMA50", "50DMA"), ("SMA200", "200DMA")):
        if v(suffix) is not None:
            parts.append(f"{label} {v(suffix):.1f}")
    spot = prices.latest(conn, prefix)
    sma50, sma200 = v("SMA50"), v("SMA200")
    if spot is not None and sma50 is not None and sma200 is not None:
        above50, above200 = spot["value"] > sma50, spot["value"] > sma200
        if above50 == above200:
            regime = "above both" if above50 else "below both"
        else:
            regime = "above 50DMA, below 200DMA" if above50 else "below 50DMA, above 200DMA"
        parts.append(f"spot {regime}")
    if v("PIV_S1") is not None and v("PIV_R1") is not None:
        parts.append(f"month-pivot S1 {v('PIV_S1'):.1f} / R1 {v('PIV_R1'):.1f}")
    date = max(row["ts"] for row in vals.values())[:10]
    return f"{prefix} technicals @{date}: " + ", ".join(parts)


def render(conn: sqlite3.Connection, now: str | None = None) -> str:
    now = now or utcnow()
    symbols = [
        r["symbol"]
        for r in conn.execute("SELECT DISTINCT symbol FROM prices ORDER BY symbol")
    ]
    if not symbols:
        return "no price data"
    lines = []
    tech: dict[str, dict[str, sqlite3.Row]] = {}
    for symbol in symbols:
        split = _tech_split(symbol)
        if split:
            tech.setdefault(split[0], {})[split[1]] = prices.latest(conn, symbol)
            continue
        row = prices.latest(conn, symbol)
        value = row["value"]
        date = row["ts"][:10]
        lines.append(
            f"{symbol} {value:g} @{date} "
            f"(24h: {_delta(conn, symbol, value, _shift(now, 24), row['ts'])}, "
            f"7d: {_delta(conn, symbol, value, _shift(now, 24 * 7), row['ts'])})"
        )
    for prefix in sorted(tech):
        lines.append(_tech_line(conn, prefix, tech[prefix]))
    return "\n".join(lines)
