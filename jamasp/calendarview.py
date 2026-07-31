"""Compact upcoming-events view for agent runs and the operator."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

from jamasp.db import utcnow

DUBAI = timezone(timedelta(hours=4))
DEFAULT_IMPACTS = ("High", "Medium")


def render(
    conn: sqlite3.Connection,
    days: int = 14,
    now: str | None = None,
    impact_min: str = "default",
) -> str:
    start = now or utcnow()
    end_dt = datetime.fromisoformat(start.replace("Z", "+00:00")) + timedelta(days=days)
    end = end_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = conn.execute(
        "SELECT * FROM events WHERE starts_at >= ? AND starts_at < ? ORDER BY starts_at",
        (start, end),
    ).fetchall()
    if impact_min != "all":
        rows = [r for r in rows if r["impact"] in DEFAULT_IMPACTS]
    lines = [f"# jamasp calendar — {len(rows)} events next {days}d (times: UTC + Dubai)"]
    for r in rows:
        dt = datetime.fromisoformat(r["starts_at"].replace("Z", "+00:00"))
        lines.append(json.dumps({
            "t_utc": r["starts_at"],
            "t_dubai": dt.astimezone(DUBAI).strftime("%Y-%m-%d %H:%M"),
            "title": r["title"],
            "country": r["country"],
            "impact": r["impact"],
        }, ensure_ascii=False))
    return "\n".join(lines)
