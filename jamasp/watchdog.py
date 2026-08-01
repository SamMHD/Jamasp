"""No-LLM health checks; Jamasp being down is never silent."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jamasp import runner
from jamasp.db import get_meta, utcnow

DUBAI = timezone(timedelta(hours=4))
INGEST_STALE_MINUTES = 60
WAKEUP_STUCK_MINUTES = 30


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def check(conn: sqlite3.Connection, reports_dir: Path, now: str | None = None) -> list[str]:
    now_dt = _parse(now or utcnow())
    violations: list[str] = []

    last_ingest = get_meta(conn, "last_ingest_at")
    if last_ingest is None:
        violations.append("ingest has never recorded a heartbeat (meta.last_ingest_at missing)")
    elif now_dt - _parse(last_ingest) > timedelta(minutes=INGEST_STALE_MINUTES):
        violations.append(f"ingest stale: last ran {last_ingest} (> {INGEST_STALE_MINUTES} min ago)")

    yesterday = (now_dt.astimezone(DUBAI) - timedelta(days=1)).strftime("%Y-%m-%d")
    y, m, _ = yesterday.split("-")
    brief = Path(reports_dir) / y / m / f"{yesterday}-brief.md"
    if not brief.exists():
        violations.append(f"yesterday's brief missing: {brief}")

    threshold = (now_dt - timedelta(minutes=WAKEUP_STUCK_MINUTES)).strftime("%Y-%m-%dT%H:%M:%SZ")
    stuck = conn.execute(
        "SELECT COUNT(*) FROM wakeups WHERE status = 'pending' AND due_at < ?",
        (threshold,),
    ).fetchone()[0]
    if stuck:
        violations.append(f"wakeup queue stuck: {stuck} pending entries overdue > {WAKEUP_STUCK_MINUTES} min")

    return violations


def run(
    conn: sqlite3.Connection, settings: dict, reports_dir: Path, now: str | None = None
) -> list[str]:
    violations = check(conn, reports_dir, now=now)
    if violations:
        runner._notify_safe(
            conn, settings, "Jamasp watchdog:\n" + "\n".join(f"- {v}" for v in violations)
        )
    return violations
