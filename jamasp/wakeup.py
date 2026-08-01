"""Wakeup queue: the agent requests future runs; the dispatcher executes them."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from jamasp.db import utcnow

RUN_TYPES = {"deepdive", "scan", "brief", "retro"}


def _normalize_due(due_at: str) -> str:
    try:
        dt = datetime.fromisoformat(due_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"due_at must be ISO-8601, got {due_at!r}") from exc
    if dt.tzinfo is None:
        raise ValueError(f"due_at must carry a timezone (Z or offset), got {due_at!r}")
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def add(conn: sqlite3.Connection, due_at: str, run_type: str, task: str) -> int:
    if run_type not in RUN_TYPES:
        raise ValueError(f"run_type must be one of {sorted(RUN_TYPES)}, got {run_type!r}")
    cur = conn.execute(
        "INSERT INTO wakeups (due_at, run_type, task, created_at) VALUES (?, ?, ?, ?)",
        (_normalize_due(due_at), run_type, task, utcnow()),
    )
    conn.commit()
    return cur.lastrowid


def list_open(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM wakeups WHERE status = 'pending' ORDER BY due_at"
    ).fetchall()


def due(conn: sqlite3.Connection, now: str | None = None) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM wakeups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at",
        (now or utcnow(),),
    ).fetchall()


def record_attempt(conn: sqlite3.Connection, wakeup_id: int) -> int:
    conn.execute(
        "UPDATE wakeups SET attempts = attempts + 1 WHERE id = ?", (wakeup_id,)
    )
    conn.commit()
    row = conn.execute(
        "SELECT attempts FROM wakeups WHERE id = ?", (wakeup_id,)
    ).fetchone()
    return row["attempts"]


def mark(conn: sqlite3.Connection, wakeup_id: int, status: str) -> None:
    conn.execute(
        "UPDATE wakeups SET status = ?, fired_at = ? WHERE id = ?",
        (status, utcnow(), wakeup_id),
    )
    conn.commit()


def cancel(conn: sqlite3.Connection, wakeup_id: int) -> None:
    row = conn.execute(
        "SELECT status FROM wakeups WHERE id = ?", (wakeup_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"no wakeup #{wakeup_id}")
    if row["status"] != "pending":
        raise ValueError(f"wakeup #{wakeup_id} is {row['status']}, not pending")
    conn.execute(
        "UPDATE wakeups SET status = 'cancelled' WHERE id = ?", (wakeup_id,)
    )
    conn.commit()
