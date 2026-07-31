"""Readability extraction: the only path for web content into agent context."""
from __future__ import annotations

import os
import sqlite3
from typing import Callable

import httpx
import trafilatura

from jamasp.db import utcnow


# Publishers (CNBC, Mining.com, MarketWatch, …) block non-browser User-Agents
# with 401/403. Identify as a browser so article pages are retrievable.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _default_fetch(url: str) -> str:
    resp = httpx.get(
        url, headers=BROWSER_HEADERS, follow_redirects=True, timeout=30
    )
    resp.raise_for_status()
    return resp.text


# Even with a browser UA, several publishers (CNBC, MarketWatch, Investing)
# reject requests from datacenter IPs outright. JAMASP_EXTRACT_PROXY names a
# local egress proxy (WARP in proxy mode: socks5://127.0.0.1:40000) used as a
# fallback ONLY inside this fetch — system routing is never touched.
PROXY_ENV_VAR = "JAMASP_EXTRACT_PROXY"


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
