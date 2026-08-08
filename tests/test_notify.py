import pytest

from jamasp import notify

SETTINGS = {"telegram": {"bot_token_env": "JAMASP_TG_TOKEN", "chat_id_env": "JAMASP_TG_CHAT"}}


def test_send_telegram_posts_to_bot_api():
    sent = {}

    def fake_post(url, data):
        sent["url"], sent["data"] = url, data
        return {"ok": True, "result": {"message_id": 1}}

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


def test_log_sent_records_row(tmp_path):
    from jamasp import db as db_mod
    from jamasp import notify as notify_mod

    conn = db_mod.connect(tmp_path / "t.db")
    notify_mod.log_sent(conn, "سلام desk", ok=True)
    notify_mod.log_sent(conn, "failed one", ok=False)
    rows = conn.execute("SELECT text, ok FROM notify_log ORDER BY id").fetchall()
    assert [(r["text"], r["ok"]) for r in rows] == [("سلام desk", 1), ("failed one", 0)]


def test_send_telegram_returns_message_id():
    def fake_post(url, data):
        return {"ok": True, "result": {"message_id": 4242}}

    assert notify.send_telegram("hi", "TOK", "-100", post=fake_post) == 4242


def test_edit_telegram_posts_message_id():
    sent = {}

    def fake_post(url, data):
        sent["url"], sent["data"] = url, data
        return {"ok": True, "result": {"message_id": 7}}

    notify.edit_telegram("new text", "TOK", "-100", 7, post=fake_post)
    assert sent["url"].endswith("/editMessageText")
    assert sent["data"] == {"chat_id": "-100", "text": "new text", "message_id": 7}


def test_edit_telegram_raises_message_gone():
    def fake_post(url, data):
        return {"ok": False, "description": "Bad Request: message to edit not found"}

    with pytest.raises(notify.MessageGone):
        notify.edit_telegram("t", "TOK", "-100", 7, post=fake_post)


def test_edit_telegram_raises_runtime_error_on_other_failure():
    def fake_post(url, data):
        return {"ok": False, "description": "Bad Request: chat not found"}

    with pytest.raises(RuntimeError) as exc:
        notify.edit_telegram("t", "TOK", "-100", 7, post=fake_post)
    assert not isinstance(exc.value, notify.MessageGone)


def test_resolve_chat_picks_news_env(monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "TOK")
    monkeypatch.setenv("JAMASP_TG_CHAT", "-100desk")
    monkeypatch.setenv("JAMASP_TG_NEWS_CHAT", "-100news")
    settings = {
        "telegram": {
            "bot_token_env": "JAMASP_TG_TOKEN",
            "chat_id_env": "JAMASP_TG_CHAT",
            "news_chat_id_env": "JAMASP_TG_NEWS_CHAT",
        }
    }
    assert notify.resolve_chat(settings, "desk") == ("TOK", "-100desk")
    assert notify.resolve_chat(settings, "news") == ("TOK", "-100news")


def test_resolve_chat_news_missing_env_raises(monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "TOK")
    monkeypatch.delenv("JAMASP_TG_NEWS_CHAT", raising=False)
    settings = {
        "telegram": {
            "bot_token_env": "JAMASP_TG_TOKEN",
            "chat_id_env": "JAMASP_TG_CHAT",
            "news_chat_id_env": "JAMASP_TG_NEWS_CHAT",
        }
    }
    with pytest.raises(RuntimeError, match="JAMASP_TG_NEWS_CHAT"):
        notify.resolve_chat(settings, "news")
