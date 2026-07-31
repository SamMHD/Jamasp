"""Economic-calendar ingestion: ForexFactory weekly JSON -> events table."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone

import httpx

from jamasp.config import Source
from jamasp.db import utcnow
from jamasp.net import get_with_fallback


def _event_id(source_name: str, title: str, starts_at: str) -> str:
    raw = f"{source_name}|{title}|{starts_at}".encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def parse_ff_json(source: Source, text: str) -> list[dict]:
    events = []
    for row in json.loads(text):
        title = (row.get("title") or "").strip()
        date = (row.get("date") or "").strip()
        if not title or not date:
            continue
        dt = datetime.fromisoformat(date)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        starts_at = dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        events.append({
            "id": _event_id(source.name, title, starts_at),
            "source": source.name,
            "title": title,
            "country": (row.get("country") or "").strip(),
            "impact": (row.get("impact") or "").strip(),
            "starts_at": starts_at,
        })
    return events


PARSERS = {"ff_json": parse_ff_json}


def fetch_source(source: Source, client: httpx.Client) -> list[dict]:
    resp = get_with_fallback(source.url, client)
    return PARSERS[source.parser](source, resp.text)


def store_events(conn: sqlite3.Connection, events: list[dict]) -> int:
    now = utcnow()
    inserted = 0
    for e in events:
        cur = conn.execute(
            "INSERT OR IGNORE INTO events (id, source, title, country, impact, starts_at, fetched_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (e["id"], e["source"], e["title"], e["country"], e["impact"], e["starts_at"], now),
        )
        inserted += cur.rowcount
    conn.commit()
    return inserted
