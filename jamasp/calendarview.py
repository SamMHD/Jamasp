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
    # The only calendar source is ff_calendar_thisweek.json, so the feed never
    # reaches beyond the current week however many days are asked for. Saying
    # "next 14d" without that caveat got read as an outage by two retros
    # rather than as a horizon; state the real coverage instead.
    covered_to = conn.execute("SELECT MAX(starts_at) m FROM events").fetchone()["m"]
    header = f"# jamasp calendar — {len(rows)} events next {days}d (times: UTC + Dubai)"
    if covered_to is None:
        header += " — no events stored; run `jamasp ingest`"
    else:
        header += (
            f"; feed covers to {covered_to[:10]}, further out is"
            " state/calendar.yaml, not this feed"
        )
    lines = [header]
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
