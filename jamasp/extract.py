"""Readability extraction: the only path for web content into agent context."""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime
from typing import Callable

import httpx
import trafilatura

from jamasp.db import utcnow
from jamasp.net import BROWSER_HEADERS, PROXY_ENV_VAR


def _default_fetch(url: str) -> str:
    resp = httpx.get(
        url, headers=BROWSER_HEADERS, follow_redirects=True, timeout=30
    )
    resp.raise_for_status()
    return resp.text


def _proxy_fetch(url: str) -> str:
    proxy = os.environ.get(PROXY_ENV_VAR)
    if not proxy:
        raise httpx.ProxyError(f"{PROXY_ENV_VAR} not configured")
    resp = httpx.get(
        url,
        headers=BROWSER_HEADERS,
        follow_redirects=True,
        timeout=30,
        proxy=proxy,
    )
    resp.raise_for_status()
    return resp.text


def cached_at(conn: sqlite3.Connection, url: str) -> str | None:
    """When this URL's cached extract was fetched, or None if uncached."""
    row = conn.execute(
        "SELECT fetched_at FROM extract_cache WHERE url = ?", (url,)
    ).fetchone()
    return row["fetched_at"] if row else None


def _age_hours(fetched_at: str, now: str) -> float:
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    delta = datetime.strptime(now, fmt) - datetime.strptime(fetched_at, fmt)
    return delta.total_seconds() / 3600


def extract_url(
    conn: sqlite3.Connection,
    url: str,
    max_chars: int = 16000,
    fetch: Callable[[str], str] | None = None,
    proxy_fetch: Callable[[str], str] | None = None,
    max_age_hours: float | None = None,
    now: str | None = None,
) -> str:
    """Extract article text, caching by URL.

    `max_age_hours` expires a cached entry: index and section pages are
    rewritten continuously, so replaying an old snapshot of one reads a
    days-old tape as live. Left at None the cache never expires, which is
    what article bodies want — they don't change.
    """
    cached = conn.execute(
        "SELECT fetched_at, text FROM extract_cache WHERE url = ?", (url,)
    ).fetchone()
    if cached and (
        max_age_hours is None
        or _age_hours(cached["fetched_at"], now or utcnow()) < max_age_hours
    ):
        return cached["text"]
    text = None
    direct_error: Exception | None = None
    try:
        html = (fetch or _default_fetch)(url)
        text = trafilatura.extract(html, url=url)
    except httpx.HTTPError as exc:
        direct_error = exc
    if not text:
        try:
            html = (proxy_fetch or _proxy_fetch)(url)
            text = trafilatura.extract(html, url=url)
        except httpx.HTTPError as exc:
            raise ValueError(
                f"could not extract article text from {url} "
                f"(direct: {direct_error or 'no article text'}; proxy: {exc})"
            ) from exc
    if not text or not text.strip():
        raise ValueError(f"could not extract article text from {url}")
    if len(text) > max_chars:
        text = text[:max_chars] + "\n[truncated]"
    conn.execute(
        "INSERT INTO extract_cache (url, fetched_at, text) VALUES (?, ?, ?)"
        " ON CONFLICT(url) DO UPDATE SET fetched_at = excluded.fetched_at,"
        " text = excluded.text",
        (url, now or utcnow(), text),
    )
    conn.commit()
    return text
