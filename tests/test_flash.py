import sqlite3
from datetime import datetime, timedelta, timezone

from jamasp import db, flash
from jamasp.ingest import rss
from jamasp.models import Item


def ago(hours):
    dt = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def seed(conn, specs):
    """specs: list of (source, headline, hours_ago). Returns item ids."""
    items = [
        Item(
            id=rss.item_id(src, f"https://e/{i}", head),
            source=src,
            published_at=ago(hrs),
            headline=head,
            url=f"https://e/{i}",
            topic="gold",
        )
        for i, (src, head, hrs) in enumerate(specs)
    ]
    rss.store_items(conn, items)
    return [it.id for it in items]


def test_candidates_respects_age_window_and_order(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    fresh, old = seed(conn, [("a", "Fresh story", 1), ("b", "Old story", 9)])
    rows = flash.candidates(conn, max_age_hours=6, limit=30)
    assert [r["id"] for r in rows] == [fresh]
    assert old not in [r["id"] for r in rows]


def test_candidates_excludes_already_processed(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    one, two = seed(conn, [("a", "One", 1), ("b", "Two", 2)])
    flash.record(conn, one, None, "not_gold")
    assert [r["id"] for r in flash.candidates(conn, 6, 30)] == [two]


def test_candidates_honours_limit(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("a", "One", 1), ("b", "Two", 2), ("c", "Three", 3)])
    assert len(flash.candidates(conn, 6, 2)) == 2


def test_retire_stale_marks_only_old_unprocessed(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    fresh, old = seed(conn, [("a", "Fresh", 1), ("b", "Old", 9)])
    assert flash.retire_stale(conn, 6) == {"stale": 0, "born_old": 1}
    row = conn.execute(
        "SELECT state FROM flash_items WHERE item_id = ?", (old,)
    ).fetchone()
    # seed() fetches everything now, so a 9h-old item was already past the
    # window when first seen — born old, never postable, not starvation.
    assert row["state"] == "skipped_born_old"
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (fresh,)
    ).fetchone()["c"] == 0
    # idempotent: a second pass finds nothing new
    assert flash.retire_stale(conn, 6) == {"stale": 0, "born_old": 0}


def test_posted_flashes_window_and_published_at(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (origin,) = seed(conn, [("a", "Gold hits record", 2)])
    conn.execute(
        "INSERT INTO flashes (id, created_at, updated_at, title_en, title_fa,"
        " summary_fa, impact_fa, url, message_id, status)"
        " VALUES (?, ?, ?, 'Gold hits record', 'fa', 's', 'i', 'https://e/0', 5, 'sent')",
        (origin, ago(2), ago(2)),
    )
    conn.commit()
    rows = flash.posted_flashes(conn, hours=24)
    assert [r["id"] for r in rows] == [origin]
    assert rows[0]["published_at"] == ago(2)
    assert flash.posted_flashes(conn, hours=1) == []


def test_log_error_writes_source_errors(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    flash.log_error(conn, ValueError("boom"))
    row = conn.execute(
        "SELECT source, error FROM source_errors WHERE source = 'flash'"
    ).fetchone()
    assert row is not None and "boom" in row["error"]


import json

import pytest

from jamasp.config import Source

SOURCES = [
    Source(name="reuters", type="rss", url="u", interval_minutes=15,
           topic="gold", display="Reuters"),
    Source(name="cnbc", type="rss", url="u", interval_minutes=15,
           topic="gold", display="CNBC"),
]

SETTINGS = {
    "telegram": {
        "bot_token_env": "JAMASP_TG_TOKEN",
        "chat_id_env": "JAMASP_TG_CHAT",
        "news_chat_id_env": "JAMASP_TG_NEWS_CHAT",
    },
    "flash": {
        "enabled": True,
        "max_age_hours": 6,
        "max_posts_per_tick": 10,
        "classify_batch_max": 30,
        "extract_chars": 4000,
        "decide_cmd": ["fake-decide"],
        "write_cmd": ["fake-write"],
    },
}


@pytest.fixture(autouse=True)
def tg_env(monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "TOK")
    monkeypatch.setenv("JAMASP_TG_CHAT", "-100desk")
    monkeypatch.setenv("JAMASP_TG_NEWS_CHAT", "-100news")


class FakePoster:
    """Records Telegram calls; returns incrementing message ids."""

    def __init__(self, fail_on=None, edit_error=None):
        self.calls = []
        self.next_id = 100
        self.fail_on = fail_on or set()
        self.edit_error = edit_error

    def __call__(self, url, data):
        kind = "edit" if url.endswith("editMessageText") else "send"
        self.calls.append((kind, data))
        if kind in self.fail_on:
            return {"ok": False, "description": "Bad Request: chat not found"}
        if kind == "edit" and self.edit_error:
            return {"ok": False, "description": self.edit_error}
        self.next_id += 1
        return {"ok": True, "result": {"message_id": self.next_id}}


def model(verdicts, write=None):
    """Build a run_model fake: decide returns verdicts, write returns fixed fields."""
    written = write or {"title_fa": "عنوان", "summary_fa": "خلاصه", "impact_fa": "اثر"}

    def run(cmd, prompt):
        if cmd == ["fake-decide"]:
            return json.dumps(verdicts)
        return json.dumps(written)

    return run


def no_extract(monkeypatch):
    """Force the extraction fallback so tests never hit the network."""
    from jamasp import extract as extract_mod

    monkeypatch.setattr(
        extract_mod, "extract_url",
        lambda *a, **k: (_ for _ in ()).throw(ValueError("no network")),
    )


def test_run_flash_posts_new_story(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": None}}),
    )
    assert stats["posted"] == 1
    assert [c[0] for c in poster.calls] == ["send"]
    assert poster.calls[0][1]["chat_id"] == "-100news"
    assert "منابع: Reuters" in poster.calls[0][1]["text"]
    row = conn.execute("SELECT * FROM flashes WHERE id = ?", (one,)).fetchone()
    assert row["message_id"] == 101 and row["status"] == "sent"
    assert conn.execute(
        "SELECT state FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["state"] == "posted"
    # flashes stay out of the desk alert log
    assert conn.execute("SELECT COUNT(*) c FROM notify_log").fetchone()["c"] == 0
    # and never mark items read
    assert conn.execute(
        "SELECT read_at FROM items WHERE id = ?", (one,)
    ).fetchone()["read_at"] is None


def test_run_flash_skips_non_gold(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Widget maker earnings", 1)])
    poster = FakePoster()
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": False, "dup_of": None}}),
    )
    assert stats["not_gold"] == 1 and poster.calls == []
    assert conn.execute(
        "SELECT state FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["state"] == "not_gold"


def test_run_flash_edits_message_on_duplicate(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 2)])
    poster = FakePoster()
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({one: {"gold": True, "dup_of": None}}))
    (two,) = seed(conn, [("cnbc", "Bullion surges to all-time high", 1)])
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({two: {"gold": True, "dup_of": one}}),
    )
    assert stats["dup"] == 1 and stats["posted"] == 0
    kinds = [c[0] for c in poster.calls]
    assert kinds == ["send", "edit"]
    edit = poster.calls[1][1]
    assert edit["message_id"] == 101
    assert "منابع: Reuters • CNBC" in edit["text"]
    assert "عنوان" in edit["text"]          # paragraphs unchanged
    assert conn.execute(
        "SELECT flash_id, state FROM flash_items WHERE item_id = ?", (two,)
    ).fetchone()["flash_id"] == one


def test_run_flash_skips_edit_when_label_already_present(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 2)])
    poster = FakePoster()
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({one: {"gold": True, "dup_of": None}}))
    (two,) = seed(conn, [("reuters", "Gold hits a record high", 1)])
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({two: {"gold": True, "dup_of": one}}))
    assert [c[0] for c in poster.calls] == ["send"]   # no edit attempted


def test_run_flash_dedupes_within_one_tick(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    first, second = seed(
        conn, [("reuters", "Gold hits record", 1), ("cnbc", "Bullion surges", 2)]
    )
    poster = FakePoster()
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({
            first: {"gold": True, "dup_of": None},
            second: {"gold": True, "dup_of": first},
        }),
    )
    assert (stats["posted"], stats["dup"]) == (1, 1)
    assert [c[0] for c in poster.calls] == ["send", "edit"]


def test_run_flash_treats_unknown_dup_target_as_new(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": "hallucinated"}}),
    )
    assert stats["posted"] == 1 and [c[0] for c in poster.calls] == ["send"]


def test_run_flash_orphans_flash_when_message_gone(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 2)])
    poster = FakePoster()
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({one: {"gold": True, "dup_of": None}}))
    poster.edit_error = "Bad Request: message to edit not found"
    (two,) = seed(conn, [("cnbc", "Bullion surges", 1)])
    stats = flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                            run_model=model({two: {"gold": True, "dup_of": one}}))
    assert stats["dup"] == 1 and stats["errors"] == 0
    assert conn.execute(
        "SELECT status FROM flashes WHERE id = ?", (one,)
    ).fetchone()["status"] == "orphaned"
    # a third source is absorbed without another edit attempt
    edits_before = len([c for c in poster.calls if c[0] == "edit"])
    (three,) = seed(conn, [("reuters", "Gold record confirmed", 1)])
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({three: {"gold": True, "dup_of": one}}))
    assert len([c for c in poster.calls if c[0] == "edit"]) == edits_before


def test_run_flash_burst_cap_drops_overflow(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    ids = seed(conn, [("reuters", f"Story {i}", 1) for i in range(4)])
    settings = {**SETTINGS, "flash": {**SETTINGS["flash"], "max_posts_per_tick": 2}}
    poster = FakePoster()
    stats = flash.run_flash(
        conn, settings, SOURCES, post=poster,
        run_model=model({i: {"gold": True, "dup_of": None} for i in ids}),
    )
    assert (stats["posted"], stats["burst"]) == (2, 2)
    assert len([c for c in poster.calls if c[0] == "send"]) == 2
    assert conn.execute("SELECT COUNT(*) c FROM flashes").fetchone()["c"] == 2
    dropped = conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE state = 'skipped_burst'"
    ).fetchone()["c"]
    assert dropped == 2
    # dropped items are not dedupe targets later — they left no flashes row
    assert conn.execute(
        "SELECT COUNT(*) c FROM flashes WHERE status = 'skipped_burst'"
    ).fetchone()["c"] == 0


def test_run_flash_send_failure_leaves_item_unprocessed(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster(fail_on={"send"})
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": None}}),
    )
    assert stats["errors"] == 1 and stats["posted"] == 0
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM flashes").fetchone()["c"] == 0
    assert conn.execute(
        "SELECT COUNT(*) c FROM source_errors WHERE source = 'flash'"
    ).fetchone()["c"] == 1


def test_run_flash_decide_failure_touches_nothing(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()

    def broken(cmd, prompt):
        return "I refuse."

    stats = flash.run_flash(conn, SETTINGS, SOURCES, post=poster, run_model=broken)
    assert stats["errors"] == 1 and poster.calls == []
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["c"] == 0


def test_run_flash_write_failure_isolates_one_story(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    good, bad = seed(
        conn, [("reuters", "Gold hits record", 1), ("cnbc", "Miners rally", 2)]
    )

    def run(cmd, prompt):
        if cmd == ["fake-decide"]:
            return json.dumps({
                good: {"gold": True, "dup_of": None},
                bad: {"gold": True, "dup_of": None},
            })
        if "Miners rally" in prompt:
            return "I could not write this."
        return json.dumps({"title_fa": "عنوان", "summary_fa": "خلاصه",
                           "impact_fa": "اثر"})

    poster = FakePoster()
    stats = flash.run_flash(conn, SETTINGS, SOURCES, post=poster, run_model=run)
    assert (stats["posted"], stats["errors"]) == (1, 1)
    assert [c[0] for c in poster.calls] == ["send"]
    # the failed story is left unprocessed and retried next tick
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (bad,)
    ).fetchone()["c"] == 0


def test_run_flash_edit_failure_leaves_item_unprocessed(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 2)])
    poster = FakePoster()
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({one: {"gold": True, "dup_of": None}}))
    poster.fail_on = {"edit"}
    (two,) = seed(conn, [("cnbc", "Bullion surges", 1)])
    stats = flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                            run_model=model({two: {"gold": True, "dup_of": one}}))
    assert stats["errors"] == 1 and stats["dup"] == 0
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (two,)
    ).fetchone()["c"] == 0
    # the flash is untouched — not orphaned, still editable next tick
    assert conn.execute(
        "SELECT status FROM flashes WHERE id = ?", (one,)
    ).fetchone()["status"] == "sent"


def test_run_flash_records_unreadable_and_posts_nothing(tmp_path, monkeypatch):
    """A consent wall extracts fine, so only the write model can refuse it."""
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])

    def run(cmd, prompt):
        if cmd == ["fake-decide"]:
            return json.dumps({one: {"gold": True, "dup_of": None}})
        return json.dumps({"usable": False})

    poster = FakePoster()
    stats = flash.run_flash(conn, SETTINGS, SOURCES, post=poster, run_model=run)
    assert stats["unreadable"] == 1
    assert (stats["posted"], stats["errors"]) == (0, 0)
    assert poster.calls == []
    assert conn.execute("SELECT COUNT(*) c FROM flashes").fetchone()["c"] == 0
    # recorded, so it is not retried every tick for the next six hours
    assert conn.execute(
        "SELECT state FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["state"] == "unreadable"


def test_run_flash_unreadable_does_not_consume_the_post_budget(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    junk, good = seed(
        conn, [("reuters", "Junk redirect", 1), ("cnbc", "Gold hits record", 2)]
    )

    def run(cmd, prompt):
        if cmd == ["fake-decide"]:
            return json.dumps({
                junk: {"gold": True, "dup_of": None},
                good: {"gold": True, "dup_of": None},
            })
        if "Junk redirect" in prompt:
            return json.dumps({"usable": False})
        return json.dumps({"title_fa": "عنوان", "summary_fa": "خلاصه",
                           "impact_fa": "اثر"})

    settings = {**SETTINGS, "flash": {**SETTINGS["flash"], "max_posts_per_tick": 1}}
    poster = FakePoster()
    stats = flash.run_flash(conn, settings, SOURCES, post=poster, run_model=run)
    assert (stats["unreadable"], stats["posted"], stats["burst"]) == (1, 1, 0)
    assert [c[0] for c in poster.calls] == ["send"]


def test_run_flash_disabled_without_news_chat(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    monkeypatch.delenv("JAMASP_TG_NEWS_CHAT", raising=False)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": None}}),
    )
    assert stats["errors"] == 1 and poster.calls == []
    assert conn.execute(
        "SELECT COUNT(*) c FROM source_errors WHERE source = 'flash'"
    ).fetchone()["c"] == 1


def test_run_flash_missing_config_key_is_not_fatal(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    broken = {**SETTINGS["flash"]}
    del broken["max_posts_per_tick"]
    settings = {**SETTINGS, "flash": broken}
    poster = FakePoster()
    stats = flash.run_flash(
        conn, settings, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": None}}),
    )
    assert stats["errors"] == 1 and poster.calls == []
    row = conn.execute(
        "SELECT error FROM source_errors WHERE source = 'flash'"
    ).fetchone()
    assert "max_posts_per_tick" in row["error"]
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["c"] == 0


def test_run_flash_disabled_by_settings(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("reuters", "Gold hits record", 1)])
    settings = {**SETTINGS, "flash": {**SETTINGS["flash"], "enabled": False}}
    poster = FakePoster()
    stats = flash.run_flash(conn, settings, SOURCES, post=poster,
                            run_model=model({}))
    assert stats == {"posted": 0, "dup": 0, "not_gold": 0, "unreadable": 0, "stale": 0,
                     "born_old": 0, "burst": 0, "errors": 0}
    assert poster.calls == []


def test_run_flash_dry_run_emits_without_sending(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()
    seen = []
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": None}}),
        emit=seen.append, dry_run=True,
    )
    assert poster.calls == []
    assert stats["posted"] == 1
    assert len(seen) == 1 and "منابع: Reuters" in seen[0]
    assert conn.execute("SELECT COUNT(*) c FROM flashes").fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM flash_items").fetchone()["c"] == 0


def test_run_flash_survives_a_raising_record(tmp_path, monkeypatch):
    # flash must never raise into the ingest run, whichever step breaks.
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Widget maker earnings", 1)])

    def boom(*a, **k):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(flash, "record", boom)
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=FakePoster(),
        run_model=model({one: {"gold": False, "dup_of": None}}),
    )
    assert stats["errors"] == 1
    assert conn.execute(
        "SELECT COUNT(*) c FROM source_errors WHERE source = 'flash'"
    ).fetchone()["c"] == 1


def test_run_flash_survives_a_raising_candidates(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("reuters", "Gold hits record", 1)])

    def boom(*a, **k):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(flash, "candidates", boom)
    poster = FakePoster()
    stats = flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                            run_model=model({}))
    assert stats["errors"] == 1 and poster.calls == []
    assert conn.execute(
        "SELECT COUNT(*) c FROM source_errors WHERE source = 'flash'"
    ).fetchone()["c"] == 1


class HalfWrittenConn:
    """Real connection that dies on the publish's flash_items insert."""

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def __enter__(self):
        return self._conn.__enter__()

    def __exit__(self, *exc):
        return self._conn.__exit__(*exc)

    def execute(self, sql, params=()):
        if "flash_items" in sql and len(params) > 2 and params[2] == "posted":
            raise sqlite3.OperationalError("disk I/O error")
        return self._conn.execute(sql, params)


def test_publish_write_is_atomic(tmp_path, monkeypatch):
    # A death between the flashes insert and the flash_items row would leave the
    # item a candidate again: a second Telegram message next tick, then an
    # IntegrityError on flashes.id aborting ingest every 15 minutes.
    no_extract(monkeypatch)
    real = db.connect(tmp_path / "t.db")
    (one,) = seed(real, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()
    stats = flash.run_flash(
        HalfWrittenConn(real), SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": None}}),
    )
    assert (stats["posted"], stats["errors"]) == (0, 1)
    assert [c[0] for c in poster.calls] == ["send"]  # the message did go out
    orphans = real.execute(
        "SELECT COUNT(*) c FROM flashes f"
        " LEFT JOIN flash_items i ON i.flash_id = f.id WHERE i.item_id IS NULL"
    ).fetchone()["c"]
    assert orphans == 0
    # neither half survived, so the next tick simply retries the item
    assert real.execute("SELECT COUNT(*) c FROM flashes").fetchone()["c"] == 0
    assert real.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["c"] == 0


LONG_HTML = (
    "<html><body><article><p>"
    + "Gold rallied after the CPI print surprised to the downside. " * 60
    + "</p></article></body></html>"
)


def test_run_flash_caches_full_length_extract(tmp_path, monkeypatch):
    # extract_cache is keyed on url with no size column, and the daily brief
    # deep-reads exactly the articles flash touches. So flash must extract at
    # the full extract_max_chars budget and truncate only for its own prompt —
    # otherwise every later `jamasp extract` is capped at flash's extract_chars.
    from jamasp import extract as extract_mod

    monkeypatch.setattr(extract_mod, "_default_fetch", lambda url: LONG_HTML)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    settings = {
        **SETTINGS,
        "extract_max_chars": 16000,
        "flash": {**SETTINGS["flash"], "extract_chars": 500},
    }
    prompts = []

    def run(cmd, prompt):
        prompts.append(prompt)
        if cmd == ["fake-decide"]:
            return json.dumps({one: {"gold": True, "dup_of": None}})
        return json.dumps({"title_fa": "عنوان", "summary_fa": "خلاصه",
                           "impact_fa": "اثر"})

    stats = flash.run_flash(conn, settings, SOURCES, post=FakePoster(), run_model=run)
    assert stats["posted"] == 1
    cached = conn.execute(
        "SELECT text FROM extract_cache WHERE url = ?", ("https://e/0",)
    ).fetchone()["text"]
    assert len(cached) > 500 and "[truncated]" not in cached
    # the write prompt still carries only extract_chars of that body
    write_prompt = prompts[1]
    assert cached[:500] in write_prompt
    assert cached[:501] not in write_prompt


def test_run_flash_dry_run_does_not_retire_stale(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("reuters", "Ancient news", 40)])
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=FakePoster(), run_model=model({}),
        emit=lambda t: None, dry_run=True,
    )
    assert stats["stale"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM flash_items").fetchone()["c"] == 0


def _set_fetched_at(conn, item_id, ts):
    conn.execute("UPDATE items SET fetched_at = ? WHERE id = ?", (ts, item_id))
    conn.commit()


def test_retire_stale_separates_born_old_from_starved(tmp_path):
    # 85% of the host's 4143 skipped_stale rows were >48h old at retirement:
    # feed archive entries and the first-ingest backfill, correctly never
    # flashed. Only ~70 were genuinely starved. One state for both made the
    # number read as a pipeline defect thirty times bigger than it is.
    conn = db.connect(tmp_path / "t.db")
    born_old, starved = seed(conn, [("a", "Archive item", 30), ("b", "Was fresh", 8)])
    # the archive item was already 30h old the moment we first saw it
    _set_fetched_at(conn, born_old, ago(0.2))
    # the other was 1h old when fetched — inside the window, then aged out
    _set_fetched_at(conn, starved, ago(7))

    assert flash.retire_stale(conn, 6) == {"stale": 1, "born_old": 1}
    states = dict(
        conn.execute(
            "SELECT item_id, state FROM flash_items WHERE item_id IN (?, ?)",
            (born_old, starved),
        ).fetchall()
    )
    assert states[born_old] == "skipped_born_old"
    assert states[starved] == "skipped_stale"


def test_candidates_reserves_slots_for_the_oldest_at_risk(tmp_path):
    # published_at DESC alone means a burst of fresh arrivals outranks items
    # already close to the 6h cliff on every tick, so they age out
    # unclassified. Reserve part of the batch for the closest to expiry.
    conn = db.connect(tmp_path / "t.db")
    specs = [("fresh", f"Fresh {i}", 0.1) for i in range(20)]
    specs += [("aging", f"Aging {i}", 5.5) for i in range(5)]
    ids = seed(conn, specs)
    aging = set(ids[20:])

    picked = {r["id"] for r in flash.candidates(conn, max_age_hours=6, limit=10)}
    assert len(picked) == 10
    # without a reserve every slot goes to the 20 fresh items and none of the
    # aging ones ever get classified before retire_stale takes them
    assert picked & aging, "no aging item made the batch"


def test_run_pass_reports_stale_and_born_old_separately(tmp_path, monkeypatch):
    # The `flash:` line is where a human or an agent reads this pipeline's
    # health. One conflated "stale" count is what made a 70-item starvation
    # look like 4143.
    conn = db.connect(tmp_path / "t.db")
    born_old, starved = seed(conn, [("a", "Archive", 30), ("b", "Was fresh", 8)])
    _set_fetched_at(conn, born_old, ago(0.2))
    _set_fetched_at(conn, starved, ago(7))
    stats = flash.run_flash(
        conn, SETTINGS, [], post=lambda *a, **k: None, run_model=lambda *a: "[]"
    )
    assert stats["stale"] == 1
    assert stats["born_old"] == 1
