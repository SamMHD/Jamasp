"""Shared HTTP fetching with egress-proxy fallback for datacenter-IP blocks."""
from __future__ import annotations

import os

import httpx

# Publishers (CNBC, MarketWatch, Mining.com, …) block non-browser User-Agents
# with 401/403. Identify as a browser so pages and feeds are retrievable.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Some publishers reject datacenter IPs outright regardless of headers.
# JAMASP_EXTRACT_PROXY names a local egress proxy (WARP in proxy mode:
# socks5://127.0.0.1:40000) used as a per-request fallback — system routing
# is never touched.
PROXY_ENV_VAR = "JAMASP_EXTRACT_PROXY"


def get_with_fallback(url: str, client: httpx.Client | None = None) -> httpx.Response:
    """GET direct first; on any HTTP failure retry once through the proxy."""
    try:
        if client is not None:
            resp = client.get(url, follow_redirects=True, timeout=30)
        else:
            resp = httpx.get(
                url, headers=BROWSER_HEADERS, follow_redirects=True, timeout=30
            )
        resp.raise_for_status()
        return resp
    except httpx.HTTPError:
        proxy = os.environ.get(PROXY_ENV_VAR)
        if not proxy:
            raise
        with httpx.Client(proxy=proxy, headers=BROWSER_HEADERS) as pclient:
            resp = pclient.get(url, follow_redirects=True, timeout=30)
            resp.raise_for_status()
            return resp
