import httpx
import pytest

from jamasp import net


class OkResp:
    content = b"<rss/>"
    text = "<rss/>"

    def raise_for_status(self):
        pass


class BlockedResp:
    def raise_for_status(self):
        raise httpx.HTTPError("403 Forbidden")


class FakeClient:
    def __init__(self, resp):
        self.resp = resp
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(url)
        return self.resp


class FakeProxyClient:
    """Stands in for httpx.Client(proxy=...) in the fallback path."""

    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        FakeProxyClient.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get(self, url, **kwargs):
        return OkResp()


@pytest.fixture(autouse=True)
def _reset_proxy_instances():
    FakeProxyClient.instances = []


def test_direct_success_skips_proxy(monkeypatch):
    monkeypatch.setenv(net.PROXY_ENV_VAR, "socks5://127.0.0.1:40000")
    monkeypatch.setattr(net.httpx, "Client", FakeProxyClient)
    client = FakeClient(OkResp())
    resp = net.get_with_fallback("https://ok.example/feed", client)
    assert resp.content == b"<rss/>"
    assert FakeProxyClient.instances == []  # proxy never touched


def test_blocked_falls_back_to_proxy(monkeypatch):
    monkeypatch.setenv(net.PROXY_ENV_VAR, "socks5://127.0.0.1:40000")
    monkeypatch.setattr(net.httpx, "Client", FakeProxyClient)
    client = FakeClient(BlockedResp())
    resp = net.get_with_fallback("https://blocked.example/feed", client)
    assert resp.content == b"<rss/>"
    assert len(FakeProxyClient.instances) == 1
    assert FakeProxyClient.instances[0].kwargs["proxy"] == "socks5://127.0.0.1:40000"
    assert "Mozilla" in FakeProxyClient.instances[0].kwargs["headers"]["User-Agent"]


def test_blocked_without_proxy_env_reraises(monkeypatch):
    monkeypatch.delenv(net.PROXY_ENV_VAR, raising=False)
    monkeypatch.setattr(net.httpx, "Client", FakeProxyClient)
    client = FakeClient(BlockedResp())
    with pytest.raises(httpx.HTTPError):
        net.get_with_fallback("https://blocked.example/feed", client)
    assert FakeProxyClient.instances == []


def test_no_client_uses_browser_headers(monkeypatch):
    captured = {}

    def fake_get(url, **kwargs):
        captured["kwargs"] = kwargs
        return OkResp()

    monkeypatch.setattr(net.httpx, "get", fake_get)
    net.get_with_fallback("https://ok.example/page")
    assert "Mozilla" in captured["kwargs"]["headers"]["User-Agent"]
