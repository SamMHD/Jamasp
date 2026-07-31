"""Readability extraction: the only path for web content into agent context."""
from __future__ import annotations

import os
import sqlite3
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


def extract_url(
    conn: sqlite3.Connection,
    url: str,
    max_chars: int = 16000,
    fetch: Callable[[str], str] | None = None,
    proxy_fetch: Callable[[str], str] | None = None,
) -> str:
    cached = conn.execute(
        "SELECT text FROM extract_cache WHERE url = ?", (url,)
    ).fetchone()
    if cached:
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
        "INSERT INTO extract_cache (url, fetched_at, text) VALUES (?, ?, ?)",
        (url, utcnow(), text),
    )
    conn.commit()
    return text
