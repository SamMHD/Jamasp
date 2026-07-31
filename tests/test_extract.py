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
