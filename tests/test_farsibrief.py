from datetime import datetime, timedelta, timezone

import pytest

from jamasp import db, farsibrief
from jamasp.ingest import prices, rss
from jamasp.models import Item

NOW = "2026-10-12T10:00:00Z"


def ago(hours):
    dt = datetime(2026, 10, 12, 10, tzinfo=timezone.utc) - timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def seed(conn, specs):
    """specs: (headline, hours_ago, tier or None). Returns ids."""
    items = [Item(id=f"i{n}", source="reuters", published_at=ago(h), headline=head,
                  url=f"https://e/{n}", topic="gold", lede=f"lede {head}")
             for n, (head, h, _) in enumerate(specs)]
    rss.store_items(conn, items)
    for it, (_, _, tier) in zip(items, specs):
        if tier is not None:
            conn.execute(
                "INSERT INTO item_scores (item_id, tier, direction, conviction,"
                " theme, scored_at) VALUES (?, ?, 1, 0.9, 'SECRET_THEME', ?)",
                (it.id, tier, NOW))
    conn.commit()
    return [it.id for it in items]


@pytest.fixture
def conn(tmp_path):
    return db.connect(tmp_path / "t.db")


def test_bundle_selects_recent_scored_items_at_or_above_the_tier_cut(conn):
    seed(conn, [("Fresh tier3", 1, 3), ("Fresh tier1", 2, 1),
                ("Old tier4", 30, 4), ("Unscored", 1, None)])
    bundle = farsibrief.build_bundle(conn, {"reuters": "Reuters"}, now=NOW)
    assert "Fresh tier3" in bundle and "Reuters" in bundle
    assert "Fresh tier1" not in bundle
    assert "Old tier4" not in bundle
    assert "Unscored" not in bundle


def test_bundle_never_carries_judgement_columns(conn):
    seed(conn, [("Fed holds", 1, 4)])
    bundle = farsibrief.build_bundle(conn, {}, now=NOW)
    assert "SECRET_THEME" not in bundle
    assert "conviction" not in bundle.lower()


def test_bundle_caps_news_and_truncates_ledes(conn):
    seed(conn, [(f"H{n}", 0.01 * n, 2) for n in range(farsibrief.NEWS_CAP + 5)])
    conn.execute("UPDATE items SET lede = ? WHERE id = 'i0'", ("x" * 1000,))
    conn.commit()
    bundle = farsibrief.build_bundle(conn, {}, now=NOW)
    assert bundle.count("\n- ") == farsibrief.NEWS_CAP
    assert "x" * (farsibrief.LEDE_CHARS + 1) not in bundle


def test_bundle_with_no_news_says_so(conn):
    bundle = farsibrief.build_bundle(conn, {}, now=NOW)
    assert farsibrief.NO_NEWS in bundle


def test_bundle_includes_prices(conn):
    prices.store_price(conn, "GC", "2026-10-12T09:00:00Z", 4220.3)
    assert "GC 4220.3" in farsibrief.build_bundle(conn, {}, now=NOW)


def test_bundle_does_not_mark_items_read(conn):
    seed(conn, [("Fed holds", 1, 4)])
    farsibrief.build_bundle(conn, {}, now=NOW)
    assert conn.execute("SELECT read_at FROM items").fetchone()[0] is None


def test_prompt_carries_style_glossary_bundle_and_both_clocks():
    p = farsibrief.build_prompt("STYLE", {"Fed": "فدرال رزرو"}, "BUNDLE", NOW)
    assert "STYLE" in p and "BUNDLE" in p
    assert "Fed: فدرال رزرو" in p
    assert "2026-10-12 10:00 UTC" in p and "14:00 Dubai" in p


def test_prompt_never_reads_stance_from_disk(tmp_path, monkeypatch, conn):
    # build_bundle must be self-contained: even with a stance file present in
    # the working directory, nothing from it reaches the prompt.
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "stance.md").write_text("STANCE_MARKER")
    monkeypatch.chdir(tmp_path)
    p = farsibrief.build_prompt("S", {}, farsibrief.build_bundle(conn, {}, now=NOW), NOW)
    assert "STANCE_MARKER" not in p


def test_lock_is_exclusive_and_released(conn):
    assert not farsibrief.lock_is_held(conn)
    with farsibrief.run_lock(conn) as got:
        assert got
        assert farsibrief.lock_is_held(conn)
        with farsibrief.run_lock(conn) as second:
            assert not second
    assert not farsibrief.lock_is_held(conn)
    assert farsibrief.lock_path(conn).endswith("t.db.farsibrief.lock")


from pathlib import Path

from jamasp import modelrun

CONFIG = Path(__file__).parent.parent / "config"
SETTINGS = {
    "telegram": {"bot_token_env": "JAMASP_TG_TOKEN", "chat_id_env": "JAMASP_TG_CHAT"},
    "translate": {"cmd": ["codex", "exec"], "protocol": "codex"},
    "farsi_brief": {"timeout_seconds": 600},
}


@pytest.fixture
def tg(monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "T")
    monkeypatch.setenv("JAMASP_TG_CHAT", "-100")
    sent = []

    def post(url, data):
        sent.append(data)
        return {"ok": True, "result": {"message_id": len(sent)}}
    return sent, post


def test_generate_calls_codex_with_schema_and_replies(conn, tg):
    sent, post = tg
    calls = {}

    def run(cmd, protocol, prompt, schema, timeout):
        calls.update(cmd=cmd, protocol=protocol, schema=schema, timeout=timeout,
                     prompt=prompt)
        return {"brief": "  جمع‌بندی: طلا آرام است.  "}

    out = farsibrief.generate(conn, SETTINGS, CONFIG, {}, reply_to=7, run=run,
                              post=post, now=NOW)
    assert calls["cmd"] == ["codex", "exec"] and calls["protocol"] == "codex"
    assert calls["schema"] == farsibrief.SCHEMA and calls["timeout"] == 600
    assert "Plain, everyday Persian" in calls["prompt"]  # the prompt file
    assert sent[0]["text"] == "جمع‌بندی: طلا آرام است."
    assert sent[0]["reply_to_message_id"] == 7
    assert out == "sent 1 part(s)"
    assert conn.execute("SELECT ok FROM notify_log").fetchone()[0] == 1


def test_generate_strips_a_code_fence(conn, tg):
    sent, post = tg
    run = lambda *a, **k: {"brief": "```\nمتن بریف\n```"}
    farsibrief.generate(conn, SETTINGS, CONFIG, {}, run=run, post=post, now=NOW)
    assert sent[0]["text"] == "متن بریف"


def test_generate_splits_a_long_brief(conn, tg):
    sent, post = tg
    long = "\n\n".join(["پاراگراف " * 300] * 3)
    farsibrief.generate(conn, SETTINGS, CONFIG, {}, reply_to=7,
                        run=lambda *a, **k: {"brief": long}, post=post, now=NOW)
    assert len(sent) > 1 and all(len(d["text"]) <= 4096 for d in sent)
    assert sent[0]["reply_to_message_id"] == 7
    assert "reply_to_message_id" not in sent[1]


def test_generate_dry_run_returns_text_without_sending(conn, tg):
    sent, post = tg
    out = farsibrief.generate(conn, SETTINGS, CONFIG, {}, dry_run=True,
                              run=lambda *a, **k: {"brief": "متن"}, post=post, now=NOW)
    assert out == "متن" and sent == []


@pytest.mark.parametrize("exc,msg", [
    (modelrun.QuotaExhausted("usage limit"), farsibrief.MSG_QUOTA),
    (modelrun.ModelError("timed out"), farsibrief.MSG_FAILED),
])
def test_generate_reports_codex_failures_to_the_chat(conn, tg, exc, msg):
    sent, post = tg

    def run(*a, **k):
        raise exc
    with pytest.raises(farsibrief.FarsiBriefFailed):
        farsibrief.generate(conn, SETTINGS, CONFIG, {}, reply_to=3, run=run,
                            post=post, now=NOW)
    assert sent[0]["text"] == msg and sent[0]["reply_to_message_id"] == 3


def test_generate_treats_an_empty_brief_as_failure(conn, tg):
    sent, post = tg
    with pytest.raises(farsibrief.FarsiBriefFailed):
        farsibrief.generate(conn, SETTINGS, CONFIG, {},
                            run=lambda *a, **k: {"brief": " ``` ``` "}, post=post, now=NOW)
    assert sent[0]["text"] == farsibrief.MSG_FAILED


def test_generate_logs_a_failed_send_and_raises(conn, monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "T")
    monkeypatch.setenv("JAMASP_TG_CHAT", "-100")
    bad = lambda u, d: {"ok": False, "description": "chat not found"}
    with pytest.raises(farsibrief.FarsiBriefFailed):
        farsibrief.generate(conn, SETTINGS, CONFIG, {},
                            run=lambda *a, **k: {"brief": "متن"}, post=bad, now=NOW)
    assert conn.execute("SELECT ok FROM notify_log").fetchone()[0] == 0


def test_generate_skips_quietly_when_another_run_holds_the_lock(conn, tg):
    sent, post = tg
    with farsibrief.run_lock(conn):
        out = farsibrief.generate(conn, SETTINGS, CONFIG, {},
                                  run=lambda *a, **k: pytest.fail("ran"), post=post, now=NOW)
    assert out == "busy" and sent == []
