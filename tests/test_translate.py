from datetime import datetime, timedelta, timezone

from jamasp import db, translate
from jamasp.ingest import rss
from jamasp.models import Item


def ago(hours):
    dt = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def seed(conn, specs):
    """specs: list of (headline, hours_ago). Returns item ids."""
    items = [
        Item(
            id=rss.item_id("src", f"https://e/{i}", head),
            source="src",
            published_at=ago(hrs),
            headline=head,
            lede=f"lede for {head}",
            url=f"https://e/{i}",
            topic="gold",
        )
        for i, (head, hrs) in enumerate(specs)
    ]
    rss.store_items(conn, items)
    return [it.id for it in items]


def add_flash(conn, item_id, status="sent"):
    conn.execute(
        "INSERT INTO flashes (id, created_at, updated_at, title_en, title_fa,"
        " summary_fa, impact_fa, url, message_id, status)"
        " VALUES (?, ?, ?, 'EN', 'تیتر فارسی', 'خلاصه فارسی', 'اثر', 'u', 1, ?)",
        (item_id, ago(1), ago(1), status),
    )
    conn.commit()


def test_reuse_copies_persian_from_a_sent_flash(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("Gold climbs", 1)])
    add_flash(conn, one)

    assert translate.reuse_flash_persian(conn) == 1

    row = conn.execute("SELECT * FROM items WHERE id = ?", (one,)).fetchone()
    assert row["headline_fa"] == "تیتر فارسی"
    assert row["lede_fa"] == "خلاصه فارسی"
    assert row["fa_source"] == "flash"
    assert row["fa_at"] is not None


def test_reuse_ignores_orphaned_flashes(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("Gold climbs", 1)])
    add_flash(conn, one, status="orphaned")
    assert translate.reuse_flash_persian(conn) == 0
    row = conn.execute("SELECT headline_fa FROM items").fetchone()
    assert row["headline_fa"] is None


def test_reuse_never_overwrites_existing_persian(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("Gold climbs", 1)])
    add_flash(conn, one)
    conn.execute(
        "UPDATE items SET headline_fa = 'موجود', fa_source = 'model' WHERE id = ?",
        (one,),
    )
    conn.commit()
    assert translate.reuse_flash_persian(conn) == 0
    row = conn.execute("SELECT headline_fa, fa_source FROM items").fetchone()
    assert row["headline_fa"] == "موجود"
    assert row["fa_source"] == "model"


def test_reuse_leaves_items_without_a_flash_alone(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("No flash here", 1)])
    assert translate.reuse_flash_persian(conn) == 0


def test_reuse_is_idempotent(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("Gold climbs", 1)])
    add_flash(conn, one)
    assert translate.reuse_flash_persian(conn) == 1
    assert translate.reuse_flash_persian(conn) == 0


import pytest

from jamasp import modelrun, translatetext

CFG = {"window_days": 7, "batch_size": 2, "max_batches_per_run": 10}
GLOSSARY = {"Fed": "فدرال رزرو"}


def fake_run(answers=None, fail_on=None, calls=None):
    """A run callable standing in for modelrun.run_json.

    Answers both prompt shapes: a document prompt (which asks for a `text`
    field) gets the source back with an FA: prefix; a rows prompt gets one
    numbered entry per `headline:` line. `fail_on` is a substring that makes
    the call raise.
    """
    def run(prompt, schema):
        if calls is not None:
            calls.append(prompt)
        if fail_on and fail_on in prompt:
            raise modelrun.ModelError("boom")
        if '"text"' in prompt:                       # a document prompt
            return {"text": "FA:" + prompt.split("---\n", 1)[1]}
        return answers if answers is not None else {
            str(i): {"headline": f"FA{i}", "lede": f"LEDE{i}"}
            for i in range(1, prompt.count("headline:") + 1)
        }
    return run


def test_pending_excludes_translated_and_out_of_window(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    fresh, old = seed(conn, [("Fresh", 1), ("Old", 24 * 9)])
    done = seed(conn, [("Done", 2)])[0]
    conn.execute("UPDATE items SET headline_fa = 'x' WHERE id = ?", (done,))
    conn.commit()
    ids = [r["id"] for r in translate.pending_rows(conn, window_days=7, limit=10)]
    assert ids == [fresh]
    assert old not in ids


def test_pending_is_newest_first(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    older, newer = seed(conn, [("Older", 5), ("Newer", 1)])
    ids = [r["id"] for r in translate.pending_rows(conn, 7, 10)]
    assert ids == [newer, older]


def test_pending_excludes_rows_at_the_attempt_cap(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("Bad row", 1)])
    conn.execute("UPDATE items SET fa_attempts = ? WHERE id = ?",
                 (translate.MAX_ATTEMPTS, one))
    conn.commit()
    assert translate.pending_rows(conn, 7, 10) == []


def test_translate_rows_writes_persian_and_marks_source_model(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1), ("Two", 2)])
    stats = translate.translate_rows(conn, CFG, GLOSSARY, fake_run())
    assert stats["translated"] == 2
    rows = conn.execute(
        "SELECT headline_fa, lede_fa, fa_source FROM items"
    ).fetchall()
    assert all(r["headline_fa"].startswith("FA") for r in rows)
    assert all(r["fa_source"] == "model" for r in rows)


def test_translate_rows_respects_the_batch_ceiling(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [(f"Item {i}", 1) for i in range(10)])
    calls = []
    cfg = {**CFG, "batch_size": 2, "max_batches_per_run": 2}
    stats = translate.translate_rows(conn, cfg, GLOSSARY, fake_run(calls=calls))
    assert stats["batches"] == 2
    assert len(calls) == 2
    assert stats["translated"] == 4


def test_a_failing_batch_retries_once_then_falls_back_to_singles(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1), ("Two", 2)])
    calls = []

    def run(prompt, schema):
        calls.append(prompt)
        if prompt.count("headline:") > 1:   # the batch, either attempt
            raise modelrun.ModelError("batch failed")
        return {"1": {"headline": "FA-single"}}

    stats = translate.translate_rows(conn, CFG, GLOSSARY, run)
    # batch, batch retry, then one call per row
    assert len(calls) == 4
    assert stats["translated"] == 2
    heads = {r["headline_fa"] for r in conn.execute("SELECT headline_fa FROM items")}
    assert heads == {"FA-single"}


def test_a_row_that_fails_alone_records_attempt_and_error(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])

    def run(prompt, schema):
        raise modelrun.ModelError("always fails")

    stats = translate.translate_rows(conn, CFG, GLOSSARY, run)
    assert stats["failed"] == 1
    row = conn.execute("SELECT fa_attempts, fa_error, headline_fa FROM items").fetchone()
    assert row["fa_attempts"] == 1
    assert "always fails" in row["fa_error"]
    assert row["headline_fa"] is None


def test_a_row_reaches_the_cap_after_three_runs_and_is_abandoned(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])

    def run(prompt, schema):
        raise modelrun.ModelError("nope")

    for _ in range(3):
        translate.translate_rows(conn, CFG, GLOSSARY, run)
    assert conn.execute("SELECT fa_attempts FROM items").fetchone()[0] == 3
    assert translate.pending_rows(conn, 7, 10) == []


def test_a_row_the_model_omits_counts_as_failed(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1), ("Two", 2)])
    # answer only for entry 1
    stats = translate.translate_rows(
        conn, CFG, GLOSSARY, fake_run(answers={"1": {"headline": "FA1"}})
    )
    assert stats["translated"] == 1
    assert stats["failed"] == 1


def test_a_lede_the_model_omits_leaves_lede_fa_null(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    translate.translate_rows(
        conn, CFG, GLOSSARY, fake_run(answers={"1": {"headline": "FA1"}})
    )
    row = conn.execute("SELECT headline_fa, lede_fa FROM items").fetchone()
    assert row["headline_fa"] == "FA1"
    assert row["lede_fa"] is None


def add_event(conn, event_id, title, hours_from_now):
    dt = datetime.now(timezone.utc) + timedelta(hours=hours_from_now)
    conn.execute(
        "INSERT INTO events (id, source, title, country, impact, starts_at,"
        " fetched_at) VALUES (?, 'cal', ?, 'US', 'high', ?, ?)",
        (event_id, title, dt.strftime("%Y-%m-%dT%H:%M:%SZ"), ago(1)),
    )
    conn.commit()


def test_pending_events_includes_future_and_recent_past(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    add_event(conn, "e1", "US CPI (MoM)", 48)       # future
    add_event(conn, "e2", "FOMC Statement", -24)    # yesterday
    add_event(conn, "e3", "Ancient event", -24 * 30)
    ids = [r["id"] for r in translate.pending_events(conn, 7, 10)]
    assert set(ids) == {"e1", "e2"}


def test_translate_events_writes_title_fa(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    add_event(conn, "e1", "US CPI (MoM)", 24)

    def run(prompt, schema):
        assert "US CPI (MoM)" in prompt
        return {"1": {"title": "شاخص قیمت مصرف‌کننده آمریکا (ماهانه)"}}

    stats = translate.translate_events(conn, CFG, GLOSSARY, run)
    assert stats["translated"] == 1
    row = conn.execute("SELECT title_fa, fa_at FROM events").fetchone()
    assert row["title_fa"].startswith("شاخص")
    assert row["fa_at"] is not None


def test_translate_events_records_failure_on_the_event_row(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    add_event(conn, "e1", "US CPI (MoM)", 24)

    def run(prompt, schema):
        raise modelrun.ModelError("event boom")

    assert translate.translate_events(conn, CFG, GLOSSARY, run)["failed"] == 1
    row = conn.execute("SELECT fa_attempts, fa_error FROM events").fetchone()
    assert row["fa_attempts"] == 1
    assert "event boom" in row["fa_error"]
