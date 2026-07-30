import pytest

from jamasp import notify

SETTINGS = {"telegram": {"bot_token_env": "JAMASP_TG_TOKEN", "chat_id_env": "JAMASP_TG_CHAT"}}


def test_send_telegram_posts_to_bot_api():
    sent = {}

    def fake_post(url, data):
        sent["url"], sent["data"] = url, data
        return {"ok": True}

    notify.send_telegram("سلام gold brief", "TOK123", "-100", post=fake_post)
    assert sent["url"] == "https://api.telegram.org/botTOK123/sendMessage"
    assert sent["data"] == {"chat_id": "-100", "text": "سلام gold brief"}


def test_send_telegram_raises_on_api_error():
    with pytest.raises(RuntimeError):
        notify.send_telegram("x", "T", "C", post=lambda u, d: {"ok": False, "description": "bad"})


def test_notify_dry_run_skips_network(monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "T")
    monkeypatch.setenv("JAMASP_TG_CHAT", "C")
    out = notify.notify("hello", SETTINGS, dry_run=True, post=None)
    assert out == "[dry-run] would send 5 chars to chat C"


def test_notify_missing_env_raises(monkeypatch):
    monkeypatch.delenv("JAMASP_TG_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="JAMASP_TG_TOKEN"):
        notify.notify("hello", SETTINGS)
