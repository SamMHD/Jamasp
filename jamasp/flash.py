"""Per-story gold news flashes: classify, dedupe, publish to the news channel.

Runs as the last stage of `jamasp ingest`. Never raises into the ingest run,
never marks items read, and never consumes the daily agent-run cap.
"""
from __future__ import annotations

import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone

from jamasp.db import utcnow

MODEL_TIMEOUT_SECONDS = 120


def _since(hours: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def log_error(conn: sqlite3.Connection, exc: object) -> None:
    conn.execute(
        "INSERT INTO source_errors (source, ts, error) VALUES ('flash', ?, ?)",
        (utcnow(), str(exc)[:500]),
    )
    conn.commit()


def record(
    conn: sqlite3.Connection, item_id: str, flash_id: str | None, state: str
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO flash_items (item_id, flash_id, state, ts)"
        " VALUES (?, ?, ?, ?)",
        (item_id, flash_id, state, utcnow()),
    )
    conn.commit()


def candidates(
    conn: sqlite3.Connection, max_age_hours: int, limit: int
) -> list[sqlite3.Row]:
    """Unprocessed items inside the age window, newest first."""
    return conn.execute(
        "SELECT i.* FROM items i"
        " LEFT JOIN flash_items f ON f.item_id = i.id"
        " WHERE f.item_id IS NULL AND i.published_at >= ?"
        " ORDER BY i.published_at DESC LIMIT ?",
        (_since(max_age_hours), limit),
    ).fetchall()


def retire_stale(conn: sqlite3.Connection, max_age_hours: int) -> int:
    """Mark unprocessed items past the window as skipped_stale. They never post."""
    cur = conn.execute(
        "INSERT INTO flash_items (item_id, flash_id, state, ts)"
        " SELECT i.id, NULL, 'skipped_stale', ? FROM items i"
        " LEFT JOIN flash_items f ON f.item_id = i.id"
        " WHERE f.item_id IS NULL AND i.published_at < ?",
        (utcnow(), _since(max_age_hours)),
    )
    conn.commit()
    return cur.rowcount


def posted_flashes(conn: sqlite3.Connection, hours: int = 24) -> list[sqlite3.Row]:
    """Delivered flashes inside the window, carrying the origin item's publish time."""
    return conn.execute(
        "SELECT f.*, i.published_at AS published_at FROM flashes f"
        " JOIN items i ON i.id = f.id"
        " WHERE f.created_at >= ? ORDER BY f.created_at",
        (_since(hours),),
    ).fetchall()
