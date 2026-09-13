import sqlite3
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


def test_the_singles_loop_never_holds_the_write_lock_across_a_model_call(tmp_path):
    """The singles fallback makes one model call per row, each of which can take
    `timeout_seconds` (180) to return. A transaction spanning those calls holds
    SQLite's single write lock for up to 19 x 180s, and every other writer —
    ingest, flash, a brief, `predictions add` — fails with `database is locked`
    (busy_timeout is 5000ms and there is no WAL). So the loop must commit each
    row before it makes the next call."""
    path = tmp_path / "t.db"
    conn = db.connect(path)
    seed(conn, [("One", 1), ("Two", 2)])

    other = db.connect(path)
    # Short, so a held lock fails this test in 200ms instead of five seconds.
    other.execute("PRAGMA busy_timeout = 200")
    probes = []

    def run(prompt, schema):
        if prompt.count("headline:") > 1:      # the batch, either attempt
            raise modelrun.ModelError("batch failed")
        try:                                    # a single: another writer tries
            db.set_meta(other, f"probe.{len(probes)}", "ok")
            probes.append(True)
        except sqlite3.OperationalError as exc:
            probes.append(str(exc))
        return {"1": {"headline": "FA-single"}}

    translate.translate_rows(conn, CFG, GLOSSARY, run)
    assert probes == [True, True], probes


def test_a_locked_database_degrades_instead_of_crashing_the_run(tmp_path):
    """Contention in the other direction: another writer holds the lock when
    the singles loop tries to write. sqlite3.OperationalError must be recorded
    like any other row failure, not raise out of the run as a traceback."""
    path = tmp_path / "t.db"
    conn = db.connect(path)
    seed(conn, [("One", 1)])

    other = db.connect(path)
    other.execute("UPDATE items SET topic = 'held'")   # opens a write txn

    conn.execute("PRAGMA busy_timeout = 100")

    def run(prompt, schema):
        return {"1": {"headline": "FA1"}}

    stats = translate.translate_rows(conn, CFG, GLOSSARY, run)
    assert stats["failed"] == 1
    assert stats["translated"] == 0

    other.rollback()
    row = conn.execute("SELECT headline_fa FROM items").fetchone()
    assert row["headline_fa"] is None


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


from pathlib import Path

from jamasp import translatetext as tt

STANCE_MD = """As of 2026-09-13.

## View
Gold is bid. Weights 70/5/25 (base/event-bearish/kinetic).

## What flips me
- A hot CPI print.
"""


def doc_run(prefix="FA:"):
    def run(prompt, schema):
        source = prompt.split("---\n", 1)[1]
        return {"text": prefix + source}
    return run


def test_translate_stance_writes_a_sidecar_per_section(tmp_path):
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"

    stats = translate.translate_stance(src, side, GLOSSARY, doc_run())

    assert stats["translated"] == 3   # preamble + two sections
    sections = tt.parse_stance_sidecar(side.read_text(encoding="utf-8"))
    assert [h for h, _, _ in sections] == ["", "## View", "## What flips me"]
    assert all(body.startswith("FA:") for _, _, body in sections)


def test_translate_stance_is_a_noop_when_nothing_changed(tmp_path):
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run())

    calls = []

    def counting(prompt, schema):
        calls.append(prompt)
        return {"text": "unused"}

    stats = translate.translate_stance(src, side, GLOSSARY, counting)
    assert stats["translated"] == 0
    assert calls == []


def test_a_rewritten_section_retranslates_only_that_section(tmp_path):
    """The failure mode an empty check cannot see: stance is rewritten daily."""
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))

    src.write_text(STANCE_MD.replace("Gold is bid.", "Gold is offered."),
                   encoding="utf-8")
    calls = []

    def counting(prompt, schema):
        calls.append(prompt)
        return {"text": "NEW:changed"}

    stats = translate.translate_stance(src, side, GLOSSARY, counting)
    assert stats["translated"] == 1
    assert len(calls) == 1

    sections = dict(
        (h, b) for h, _, b in
        tt.parse_stance_sidecar(side.read_text(encoding="utf-8"))
    )
    assert sections["## View"].startswith("NEW:")
    assert sections["## What flips me"].startswith("OLD:")


def test_translate_stance_force_retranslates_everything(tmp_path):
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))
    stats = translate.translate_stance(
        src, side, GLOSSARY, doc_run("NEW:"), force=True)
    assert stats["translated"] == 3


def test_translate_stance_keeps_the_old_sidecar_when_a_section_fails(tmp_path):
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))
    before = side.read_text(encoding="utf-8")

    src.write_text(STANCE_MD.replace("Gold is bid.", "Gold is offered."),
                   encoding="utf-8")

    def failing(prompt, schema):
        raise modelrun.ModelError("doc boom")

    stats = translate.translate_stance(src, side, GLOSSARY, failing)
    assert stats["failed"] == 1
    # the unchanged sections survive; the failed one keeps its previous Persian
    assert "OLD:" in side.read_text(encoding="utf-8")
    assert side.read_text(encoding="utf-8") == before


def test_translate_stance_partial_failure_preserves_only_the_failed_hash(tmp_path):
    """The dangerous case the brief's failure test cannot see: a run where
    some sections succeed and one fails DOES rewrite the sidecar, so the
    failed section's OLD hash must survive into the new file. Stamping it
    with the new source hash instead would mark stale Persian as current and
    the section would never retranslate again."""
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))

    # Change TWO sections so both are eligible for retranslation this run.
    changed = STANCE_MD.replace(
        "Gold is bid.", "Gold is offered."
    ).replace(
        "- A hot CPI print.", "- A cooling CPI print."
    )
    src.write_text(changed, encoding="utf-8")

    before_text = side.read_text(encoding="utf-8")
    before = dict(
        (h, (sh, b)) for h, sh, b in tt.parse_stance_sidecar(before_text)
    )

    def run(prompt, schema):
        if "offered" in prompt:            # the "## View" change: succeeds
            return {"text": "NEW:View"}
        if "cooling" in prompt:            # the "## What flips me" change: fails
            raise modelrun.ModelError("flips boom")
        raise AssertionError(f"unexpected prompt: {prompt!r}")

    stats = translate.translate_stance(src, side, GLOSSARY, run)
    assert stats["translated"] == 1
    assert stats["failed"] == 1

    after_text = side.read_text(encoding="utf-8")
    assert after_text != before_text  # the sidecar WAS rewritten (unlike a total failure)
    after = dict(
        (h, (sh, b)) for h, sh, b in tt.parse_stance_sidecar(after_text)
    )

    # The succeeded section got new Persian under a new hash.
    assert after["## View"][1].startswith("NEW:View")
    assert after["## View"][0] != before["## View"][0]

    # The load-bearing assertion: the failed section's hash in the rewritten
    # file is byte-identical to what it was before this run, and its Persian
    # body is still the old translation — not the English source, not blank.
    assert after["## What flips me"][0] == before["## What flips me"][0]
    assert after["## What flips me"][1] == before["## What flips me"][1]

    # A third, fully-succeeding run must retranslate exactly the section that
    # still carries a stale (OLD) hash — proving the preserved hash actually
    # re-arms the retry rather than the file merely looking untouched.
    def run_clean(prompt, schema):
        source = prompt.split("---\n", 1)[1]
        return {"text": "FIXED:" + source}

    stats2 = translate.translate_stance(src, side, GLOSSARY, run_clean)
    assert stats2["translated"] == 1
    assert stats2["failed"] == 0

    final = dict(
        (h, b) for h, _, b in
        tt.parse_stance_sidecar(side.read_text(encoding="utf-8"))
    )
    assert final["## What flips me"].startswith("FIXED:")
    assert final["## View"].startswith("NEW:View")  # untouched: already current


def test_translate_stance_with_no_source_is_a_noop(tmp_path):
    stats = translate.translate_stance(
        tmp_path / "absent.md", tmp_path / "absent.fa.md", GLOSSARY, doc_run())
    assert stats == {"translated": 0, "failed": 0}


import json

import yaml


def test_translate_document_writes_front_matter_and_body(tmp_path):
    src = tmp_path / "playbook.md"
    src.write_text("Buy dips in an easing cycle.\n", encoding="utf-8")
    side = tmp_path / "playbook.fa.md"

    assert translate.translate_document(src, side, GLOSSARY, doc_run())["translated"] == 1

    meta, body = tt.parse_front_matter(side.read_text(encoding="utf-8"))
    assert meta["src_hash"] == tt.src_hash("Buy dips in an easing cycle.\n")
    assert meta["translator"] == "codex"
    assert body.startswith("FA:")


def test_translate_document_skips_an_unchanged_source(tmp_path):
    src = tmp_path / "playbook.md"
    src.write_text("Same.\n", encoding="utf-8")
    side = tmp_path / "playbook.fa.md"
    translate.translate_document(src, side, GLOSSARY, doc_run())

    def boom(prompt, schema):
        raise AssertionError("should not have been called")

    assert translate.translate_document(src, side, GLOSSARY, boom)["translated"] == 0


def test_translate_document_retranslates_a_changed_source(tmp_path):
    src = tmp_path / "playbook.md"
    src.write_text("First.\n", encoding="utf-8")
    side = tmp_path / "playbook.fa.md"
    translate.translate_document(src, side, GLOSSARY, doc_run("OLD:"))
    src.write_text("Second.\n", encoding="utf-8")
    translate.translate_document(src, side, GLOSSARY, doc_run("NEW:"))
    _, body = tt.parse_front_matter(side.read_text(encoding="utf-8"))
    assert body.startswith("NEW:")


def test_translate_document_leaves_the_sidecar_intact_on_failure(tmp_path):
    src = tmp_path / "playbook.md"
    src.write_text("First.\n", encoding="utf-8")
    side = tmp_path / "playbook.fa.md"
    translate.translate_document(src, side, GLOSSARY, doc_run("OLD:"))
    before = side.read_text(encoding="utf-8")
    src.write_text("Second.\n", encoding="utf-8")

    def failing(prompt, schema):
        raise modelrun.ModelError("nope")

    assert translate.translate_document(src, side, GLOSSARY, failing)["failed"] == 1
    assert side.read_text(encoding="utf-8") == before


def test_translate_watchlist_keys_by_theme_and_hashes_each_why(tmp_path):
    src = tmp_path / "watchlist.yaml"
    src.write_text(
        yaml.safe_dump({"watchlist": [
            {"theme": "real_yields", "why": "Real yields lead gold.",
             "since": "2026-08-01"},
            {"theme": "cb_buying", "why": "Central banks keep buying.",
             "since": "2026-08-05"},
        ]}, allow_unicode=True),
        encoding="utf-8",
    )
    side = tmp_path / "watchlist.fa.yaml"

    assert translate.translate_watchlist(src, side, GLOSSARY, doc_run())["translated"] == 2

    doc = yaml.safe_load(side.read_text(encoding="utf-8"))
    entries = {e["theme"]: e for e in doc["watchlist"]}
    assert entries["real_yields"]["why_fa"].startswith("FA:")
    assert entries["real_yields"]["src_hash"] == tt.src_hash("Real yields lead gold.")
    assert "why" not in entries["real_yields"]   # the sidecar carries only Persian


def test_translate_watchlist_only_retranslates_changed_entries(tmp_path):
    src = tmp_path / "watchlist.yaml"
    entries = [{"theme": "a", "why": "One.", "since": "2026-08-01"},
               {"theme": "b", "why": "Two.", "since": "2026-08-01"}]
    src.write_text(yaml.safe_dump({"watchlist": entries}), encoding="utf-8")
    side = tmp_path / "watchlist.fa.yaml"
    translate.translate_watchlist(src, side, GLOSSARY, doc_run("OLD:"))

    entries[0]["why"] = "One changed."
    src.write_text(yaml.safe_dump({"watchlist": entries}), encoding="utf-8")
    calls = []

    def counting(prompt, schema):
        calls.append(prompt)
        return {"text": "NEW:x"}

    assert translate.translate_watchlist(src, side, GLOSSARY, counting)["translated"] == 1
    assert len(calls) == 1
    doc = {e["theme"]: e for e in
           yaml.safe_load(side.read_text(encoding="utf-8"))["watchlist"]}
    assert doc["a"]["why_fa"] == "NEW:x"
    assert doc["b"]["why_fa"].startswith("OLD:")


def test_translate_predictions_keys_by_id_and_keeps_jsonl(tmp_path):
    src = tmp_path / "predictions.jsonl"
    src.write_text(
        json.dumps({"id": "p1", "claim": "Gold holds 2600."}) + "\n"
        + json.dumps({"id": "p2", "claim": "DXY breaks 105."}) + "\n",
        encoding="utf-8",
    )
    side = tmp_path / "predictions.fa.jsonl"

    assert translate.translate_predictions(src, side, GLOSSARY, doc_run())["translated"] == 2

    lines = [json.loads(l) for l in
             side.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert {l["id"] for l in lines} == {"p1", "p2"}
    assert lines[0]["claim_fa"].startswith("FA:")
    assert lines[0]["src_hash"] == tt.src_hash("Gold holds 2600.")


def test_translate_predictions_skips_lines_already_translated(tmp_path):
    src = tmp_path / "predictions.jsonl"
    src.write_text(json.dumps({"id": "p1", "claim": "Same."}) + "\n",
                   encoding="utf-8")
    side = tmp_path / "predictions.fa.jsonl"
    translate.translate_predictions(src, side, GLOSSARY, doc_run())

    def boom(prompt, schema):
        raise AssertionError("should not have been called")

    assert translate.translate_predictions(src, side, GLOSSARY, boom)["translated"] == 0


def test_translate_predictions_tolerates_a_malformed_line(tmp_path):
    src = tmp_path / "predictions.jsonl"
    src.write_text('{"id": "p1", "claim": "Fine."}\n{not json\n',
                   encoding="utf-8")
    side = tmp_path / "predictions.fa.jsonl"
    assert translate.translate_predictions(src, side, GLOSSARY, doc_run())["translated"] == 1


def test_new_reports_finds_only_untranslated_reports(tmp_path):
    reports = tmp_path / "reports" / "2026" / "09"
    reports.mkdir(parents=True)
    (reports / "2026-09-12-brief.md").write_text("A brief.\n", encoding="utf-8")
    (reports / "2026-09-11-brief.md").write_text("Older.\n", encoding="utf-8")
    (reports / "2026-09-11-brief.fa.md").write_text("x", encoding="utf-8")
    found = translate.new_reports(tmp_path / "reports", "2026-09-12")
    assert [p.name for p in found] == ["2026-09-12-brief.md"]


def test_new_reports_ignores_sidecars_themselves(tmp_path):
    reports = tmp_path / "reports" / "2026" / "09"
    reports.mkdir(parents=True)
    (reports / "2026-09-12-brief.fa.md").write_text("x", encoding="utf-8")
    assert translate.new_reports(tmp_path / "reports", "2026-01-01") == []


DOC_CFG = {**CFG, "reports_since": "2026-09-01"}


def build_state(root):
    (root / "state").mkdir(parents=True, exist_ok=True)
    (root / "state" / "stance.md").write_text(STANCE_MD, encoding="utf-8")
    (root / "state" / "playbook.md").write_text("Playbook.\n", encoding="utf-8")
    (root / "state" / "watchlist.yaml").write_text(
        yaml.safe_dump({"watchlist": [
            {"theme": "t", "why": "Why.", "since": "2026-08-01"}]}),
        encoding="utf-8")
    (root / "state" / "predictions.jsonl").write_text(
        json.dumps({"id": "p1", "claim": "Claim."}) + "\n", encoding="utf-8")
    reports = root / "reports" / "2026" / "09"
    reports.mkdir(parents=True, exist_ok=True)
    (reports / "2026-09-12-brief.md").write_text("Brief.\n", encoding="utf-8")


def test_translate_docs_covers_every_document_type(tmp_path):
    build_state(tmp_path)
    stats = translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, doc_run())
    assert stats["translated"] >= 6   # 3 stance sections + 3 docs + 1 report
    for rel in ("state/stance.fa.md", "state/playbook.fa.md",
                "state/watchlist.fa.yaml", "state/predictions.fa.jsonl",
                "reports/2026/09/2026-09-12-brief.fa.md"):
        assert (tmp_path / rel).exists(), rel


def test_translate_docs_never_writes_into_an_agent_owned_file(tmp_path):
    """The rule the whole track exists to honour."""
    build_state(tmp_path)
    before = {
        rel: (tmp_path / rel).read_bytes()
        for rel in ("state/stance.md", "state/playbook.md",
                    "state/watchlist.yaml", "state/predictions.jsonl",
                    "reports/2026/09/2026-09-12-brief.md")
    }
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, doc_run())
    for rel, content in before.items():
        assert (tmp_path / rel).read_bytes() == content, rel


def test_translate_docs_is_idempotent(tmp_path):
    build_state(tmp_path)
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, doc_run())

    def boom(prompt, schema):
        raise AssertionError("should not have been called")

    assert translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, boom)["translated"] == 0


FULL_CFG = {
    "cmd": ["true"], "protocol": "codex", "timeout_seconds": 30,
    "window_days": 7, "batch_size": 20, "max_batches_per_run": 6,
    "reports_since": "2026-09-01",
}


def test_check_reports_a_missing_config_key():
    assert "batch_size" in translate.check({k: v for k, v in FULL_CFG.items()
                                            if k != "batch_size"})


def test_check_reports_an_unknown_protocol():
    assert "protocol" in translate.check({**FULL_CFG, "protocol": "smoke"})


def test_check_reports_a_missing_binary():
    assert "not-a-real-binary-7z1" in translate.check(
        {**FULL_CFG, "cmd": ["not-a-real-binary-7z1"]})


def test_check_passes_on_a_good_config():
    assert translate.check(FULL_CFG) is None


def test_run_translate_dry_run_calls_no_model(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    build_state(tmp_path)

    def boom(prompt, schema):
        raise AssertionError("dry run must not call a model")

    stats = translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=boom, dry_run=True)
    assert stats["pending_rows"] == 1
    assert conn.execute("SELECT headline_fa FROM items").fetchone()[0] is None
    assert not (tmp_path / "state" / "stance.fa.md").exists()


def test_run_translate_only_rows_skips_documents(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    build_state(tmp_path)
    translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=fake_run(), only="rows")
    assert conn.execute("SELECT headline_fa FROM items").fetchone()[0] is not None
    assert not (tmp_path / "state" / "stance.fa.md").exists()


def test_run_translate_only_rows_still_runs_the_reuse_pass(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("One", 1)])
    add_flash(conn, one)
    calls = []
    translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY,
        run=fake_run(calls=calls), only="rows")
    assert calls == []   # the flash Persian covered it; no model call
    assert conn.execute("SELECT fa_source FROM items").fetchone()[0] == "flash"


def test_run_translate_reports_every_pass(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    build_state(tmp_path)
    stats = translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=fake_run())
    for key in ("reused", "rows", "events", "docs"):
        assert key in stats


def test_run_translate_stamps_that_the_job_ran(tmp_path):
    """The watchdog's translate probes gate on this stamp, so it is what tells
    them the job exists on this host — mirroring meta.last_ingest_at."""
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    build_state(tmp_path)
    translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=fake_run(),
        now="2026-09-13T12:00:00Z")
    assert db.get_meta(conn, "last_translate_at") == "2026-09-13T12:00:00Z"


def test_run_translate_stamps_even_when_it_translated_nothing(tmp_path):
    """The point of the stamp is that the job ran, not that it did work."""
    conn = db.connect(tmp_path / "t.db")
    translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=fake_run())
    assert db.get_meta(conn, "last_translate_at") is not None


def test_dry_run_does_not_stamp(tmp_path):
    """--dry-run is an inspection, not a run: it must not arm the probes."""
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=fake_run(), dry_run=True)
    assert db.get_meta(conn, "last_translate_at") is None
