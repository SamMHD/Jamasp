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


def test_extract_empty_raises(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    with pytest.raises(ValueError):
        extract.extract_url(conn, "https://e/x", fetch=lambda u: "<html></html>")


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
