"""Compact JSONL inbox for agent runs."""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import datetime, timedelta, timezone

from jamasp.db import utcnow


def dead_sources(conn: sqlite3.Connection, hours: int = 24) -> list[str]:
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    rows = conn.execute(
        """
        SELECT DISTINCT e.source FROM source_errors e
        WHERE e.ts >= :since
          AND NOT EXISTS (
            SELECT 1 FROM items i WHERE i.source = e.source AND i.fetched_at >= :since
          )
        ORDER BY e.source
        """,
        {"since": since},
    ).fetchall()
    return [r["source"] for r in rows]


def _also_map(conn: sqlite3.Connection) -> dict[str, list[str]]:
    rows = conn.execute(
        "SELECT cluster_id, source FROM items WHERE cluster_id != id ORDER BY source"
    ).fetchall()
    also: dict[str, list[str]] = {}
    for r in rows:
        also.setdefault(r["cluster_id"], []).append(r["source"])
    return also


def render(conn: sqlite3.Connection, cap: int = 120) -> str:
    reps = conn.execute(
        "SELECT * FROM items WHERE read_at IS NULL AND (cluster_id = id OR cluster_id IS NULL)"
        " ORDER BY published_at DESC"
    ).fetchall()
    also = _also_map(conn)
    lines = [f"# jamasp inbox {utcnow()} — {len(reps)} unread"]
    for src in dead_sources(conn):
        lines.append(
            f"# WARNING: source '{src}' had errors in the last 24h and produced"
            " no new items — possible coverage gap"
        )
    for r in reps[:cap]:
        obj = {
            "id": r["id"],
            "t": r["published_at"],
            "src": r["source"],
            "head": r["headline"],
            "topic": r["topic"],
            "url": r["url"],
        }
        if r["lede"]:
            obj["lede"] = r["lede"]
        if r["id"] in also:
            obj["also"] = also[r["id"]]
        lines.append(json.dumps(obj, ensure_ascii=False))
    if len(reps) > cap:
        overflow = Counter(r["topic"] for r in reps[cap:])
        lines.append(
            f"# +{len(reps) - cap} more unread: {json.dumps(dict(overflow), sort_keys=True)}"
        )
    return "\n".join(lines)


def mark_read(conn: sqlite3.Connection) -> int:
    cur = conn.execute(
        "UPDATE items SET read_at = ? WHERE read_at IS NULL", (utcnow(),)
    )
    conn.commit()
    return cur.rowcount
