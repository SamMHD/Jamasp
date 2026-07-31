"""Fetch and normalize RSS sources into Items."""
from __future__ import annotations

import calendar
import hashlib
import sqlite3
from datetime import datetime, timezone

import feedparser
import httpx

from jamasp.config import Source
from jamasp.db import utcnow
from jamasp.models import Item
from jamasp.net import get_with_fallback


def item_id(source_name: str, url: str, headline: str) -> str:
    raw = f"{source_name}|{url}|{headline}".encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def _published_at(entry) -> str:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if parsed:
        dt = datetime.fromtimestamp(calendar.timegm(parsed), tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    return utcnow()


def parse_feed(source: Source, content: bytes) -> list[Item]:
    feed = feedparser.parse(content)
    items = []
    for e in feed.entries:
        headline = (e.get("title") or "").strip()
        url = (e.get("link") or "").strip()
        if not headline or not url:
            continue
        items.append(
            Item(
                id=item_id(source.name, url, headline),
                source=source.name,
                published_at=_published_at(e),
                headline=headline,
                url=url,
                topic=source.topic,
            )
        )
    return items


def fetch_source(source: Source, client: httpx.Client) -> list[Item]:
    resp = get_with_fallback(source.url, client)
    return parse_feed(source, resp.content)


def store_items(conn: sqlite3.Connection, items: list[Item]) -> int:
    now = utcnow()
    inserted = 0
    for it in items:
        cur = conn.execute(
            "INSERT OR IGNORE INTO items (id, source, published_at, headline, url, topic, fetched_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (it.id, it.source, it.published_at, it.headline, it.url, it.topic, now),
        )
        inserted += cur.rowcount
    conn.commit()
    return inserted
