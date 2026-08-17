import httpx
import pytest

from jamasp import db, extract

HTML = (
    "<html><body><nav>menu menu</nav><article><p>"
    + "Gold rallied two percent after the CPI miss. " * 40
    + "</p></article></body></html>"
)


def test_extract_strips_and_truncates(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    calls = []

    def fake_fetch(url):
        calls.append(url)
        return HTML

    text = extract.extract_url(conn, "https://e/a", max_chars=200, fetch=fake_fetch)
    assert text.endswith("[truncated]")
    assert len(text) <= 200 + len("\n[truncated]")
    assert "menu menu" not in text
    assert "Gold rallied" in text


def test_extract_uses_cache(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    calls = []

    def fake_fetch(url):
        calls.append(url)
        return HTML

    a = extract.extract_url(conn, "https://e/a", max_chars=200, fetch=fake_fetch)
    b = extract.extract_url(conn, "https://e/a", max_chars=200, fetch=fake_fetch)
    assert a == b
    assert len(calls) == 1  # second call served from cache


FRESH_HTML = (
    "<html><body><article><p>"
    + "Gold tagged the 200DMA in the Asia overnight. " * 40
    + "</p></article></body></html>"
)


def _seed_cache(conn, url, text, fetched_at):
    conn.execute(
        "INSERT INTO extract_cache (url, fetched_at, text) VALUES (?, ?, ?)",
        (url, fetched_at, text),
    )
    conn.commit()


def test_extract_refetches_when_cache_older_than_max_age(tmp_path):
    # 16 Aug: an AJ index page cached three days earlier was served as fresh.
    # With a max age, a stale entry must be re-fetched, not replayed.
    conn = db.connect(tmp_path / "t.db")
    _seed_cache(conn, "https://e/index", "three-day-old snapshot", "2026-08-13T09:00:00Z")
    calls = []

    def fake_fetch(url):
        calls.append(url)
        return FRESH_HTML

    text = extract.extract_url(
        conn,
        "https://e/index",
        max_chars=2000,
        fetch=fake_fetch,
        max_age_hours=6,
        now="2026-08-16T09:00:00Z",
    )
    assert calls == ["https://e/index"]
    assert "Asia overnight" in text
    assert "three-day-old snapshot" not in text
    row = conn.execute(
        "SELECT fetched_at, text FROM extract_cache WHERE url = ?", ("https://e/index",)
    ).fetchone()
    assert row["fetched_at"] == "2026-08-16T09:00:00Z"  # entry replaced, not duplicated
    assert row["text"] == text


def test_extract_serves_cache_within_max_age(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    _seed_cache(conn, "https://e/index", "cached an hour ago", "2026-08-16T08:00:00Z")
    calls = []

    text = extract.extract_url(
        conn,
        "https://e/index",
        max_chars=2000,
        fetch=lambda u: calls.append(u) or FRESH_HTML,
        max_age_hours=6,
        now="2026-08-16T09:00:00Z",
    )
    assert calls == []
    assert text == "cached an hour ago"


def test_extract_ignores_cache_age_by_default(tmp_path):
    # flash extracts article bodies, which never change — no max age means
    # the cache stays authoritative however old it is.
    conn = db.connect(tmp_path / "t.db")
    _seed_cache(conn, "https://e/a", "ancient article body", "2026-01-01T00:00:00Z")
    calls = []

    text = extract.extract_url(
        conn,
        "https://e/a",
        max_chars=2000,
        fetch=lambda u: calls.append(u) or FRESH_HTML,
    )
    assert calls == []
    assert text == "ancient article body"


def test_cached_at_reports_entry_age(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    assert extract.cached_at(conn, "https://e/missing") is None
    _seed_cache(conn, "https://e/a", "body", "2026-08-16T08:00:00Z")
    assert extract.cached_at(conn, "https://e/a") == "2026-08-16T08:00:00Z"


ARTICLE_HTML = (
    "<html><body><article><p>"
    + "Gold steadied as yields fell after the auction. " * 30
    + "</p></article></body></html>"
)


def _proxy_unavailable(url):
    raise httpx.ProxyError("proxy not configured")


def test_extract_empty_raises(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    with pytest.raises(ValueError):
        extract.extract_url(
            conn,
            "https://e/x",
            fetch=lambda u: "<html></html>",
            proxy_fetch=_proxy_unavailable,
        )


def test_proxy_fallback_on_http_error(tmp_path):
    # Publisher blocks the box's datacenter IP (401/403) — extract must
    # retry through the egress proxy and extract the proxied HTML normally.
    conn = db.connect(tmp_path / "t.db")

    def blocked_fetch(url):
        raise httpx.HTTPError("403 Forbidden")

    text = extract.extract_url(
        conn,
        "https://blocked.example/a",
        fetch=blocked_fetch,
        proxy_fetch=lambda u: ARTICLE_HTML,
    )
    assert "Gold steadied" in text
    # fallback result must be cached like any other extraction
    row = conn.execute(
        "SELECT text FROM extract_cache WHERE url = ?", ("https://blocked.example/a",)
    ).fetchone()
    assert row["text"] == text


def test_proxy_fallback_on_empty_extraction(tmp_path):
    # Direct fetch succeeds but the page has no extractable article
    # (consent walls, JS shells) — proxy is tried before giving up.
    conn = db.connect(tmp_path / "t.db")
    text = extract.extract_url(
        conn,
        "https://shell.example/a",
        fetch=lambda u: "<html><body></body></html>",
        proxy_fetch=lambda u: ARTICLE_HTML,
    )
    assert "Gold steadied" in text


def test_proxy_fetch_requires_env(monkeypatch):
    monkeypatch.delenv(extract.PROXY_ENV_VAR, raising=False)
    with pytest.raises(httpx.ProxyError):
        extract._proxy_fetch("https://example.com/a")


def test_proxy_fetch_uses_configured_proxy(monkeypatch):
    captured = {}

    class FakeResp:
        text = "<html><body><article>ok</article></body></html>"

        def raise_for_status(self):
            pass

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs
        return FakeResp()

    monkeypatch.setattr(extract.httpx, "get", fake_get)
    monkeypatch.setenv(extract.PROXY_ENV_VAR, "socks5://127.0.0.1:40000")

    extract._proxy_fetch("https://example.com/a")
    assert captured["url"] == "https://example.com/a"
    assert captured["kwargs"]["proxy"] == "socks5://127.0.0.1:40000"
    assert "Mozilla" in captured["kwargs"]["headers"]["User-Agent"]


def test_default_fetch_sends_browser_user_agent(monkeypatch):
    # Many publishers (CNBC, Mining.com, MarketWatch) 401/403 a non-browser
    # User-Agent, so the default fetch must identify as a browser.
    captured = {}

    class FakeResp:
        text = "<html><body><article>ok</article></body></html>"

        def raise_for_status(self):
            pass

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs
        return FakeResp()

    monkeypatch.setattr(extract.httpx, "get", fake_get)
    extract._default_fetch("https://example.com/a")

    headers = captured["kwargs"]["headers"]
    assert "Mozilla" in headers["User-Agent"]
    assert captured["kwargs"]["follow_redirects"] is True
