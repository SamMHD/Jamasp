import sqlite3
import sys
from datetime import datetime, timedelta, timezone

from jamasp import db, translate
from jamasp.db import utcnow
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
        if answers is not None:
            return answers
        # The strict-mode batch shape: an array of entries each carrying its
        # own `n`, not an object keyed by entry number. See rows_schema.
        return {"items": [
            {"n": i, "headline": f"FA{i}", "lede": f"LEDE{i}"}
            for i in range(1, prompt.count("headline:") + 1)
        ]}
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


def add_score(conn, item_id, tier=2):
    """A minimal item_scores row — enough for the EXISTS join scored_only
    relies on. Values beyond item_id/tier are irrelevant to that filter."""
    conn.execute(
        "INSERT INTO item_scores (item_id, tier, direction, conviction,"
        " theme, scored_at) VALUES (?, ?, 1, 0.5, 'gold', ?)",
        (item_id, tier, utcnow()),
    )
    conn.commit()


def test_scored_only_excludes_an_unscored_item_inside_the_window(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (scored, unscored) = seed(conn, [("Scored", 1), ("Unscored", 1)])
    add_score(conn, scored)
    ids = [r["id"] for r in
           translate.pending_rows(conn, 7, 10, scored_only=True)]
    assert ids == [scored]
    assert unscored not in ids


def test_scored_only_off_selects_both(tmp_path):
    """The absent/False case: identical to the behaviour before this key
    existed — nothing conditioned on item_scores at all."""
    conn = db.connect(tmp_path / "t.db")
    (scored, unscored) = seed(conn, [("Scored", 1), ("Unscored", 2)])
    add_score(conn, scored)
    ids = {r["id"] for r in
           translate.pending_rows(conn, 7, 10, scored_only=False)}
    assert ids == {scored, unscored}


def test_translate_rows_reads_scored_only_from_config(tmp_path):
    """The config key, not just the pending_rows parameter, must reach the
    rows pass — this is what a bare `scored_only: true` in settings.yaml
    actually wires up."""
    conn = db.connect(tmp_path / "t.db")
    (scored, unscored) = seed(conn, [("Scored", 1), ("Unscored", 1)])
    add_score(conn, scored)
    cfg = {**CFG, "scored_only": True}
    stats = translate.translate_rows(conn, cfg, GLOSSARY, fake_run())
    assert stats["translated"] == 1
    row = conn.execute(
        "SELECT headline_fa FROM items WHERE id = ?", (unscored,)
    ).fetchone()
    assert row["headline_fa"] is None


def test_scored_only_never_reaches_the_events_pass(tmp_path):
    """Calendar events have no item_scores row at all (item_scores keys off
    items.id) and the desk explicitly asked to leave events alone — this
    guards against scored_only being wired into pending_events by mistake,
    which would silently stop every event from translating."""
    conn = db.connect(tmp_path / "t.db")
    add_event(conn, "e1", "US CPI (MoM)", 24)
    cfg = {**CFG, "scored_only": True}

    def run(prompt, schema):
        return {"items": [{"n": 1, "title": "NEW"}]}

    stats = translate.translate_events(conn, cfg, GLOSSARY, run)
    assert stats["translated"] == 1


def test_force_re_arms_only_the_scored_set_when_scored_only_is_on(tmp_path):
    """--force run with scored_only must re-arm (and then retranslate)
    exactly the map set — an abandoned unscored row inside the window must
    come out of this run untouched, not merely un-retranslated."""
    conn = db.connect(tmp_path / "t.db")
    (scored, unscored) = seed(conn, [("Scored", 1), ("Unscored", 1)])
    add_score(conn, scored)
    conn.execute(
        "UPDATE items SET fa_attempts = ?, fa_error = 'old'",
        (translate.MAX_ATTEMPTS,),
    )
    conn.commit()

    cfg = {**CFG, "scored_only": True}
    stats = translate.translate_rows(conn, cfg, GLOSSARY, fake_run(),
                                     force=True)
    assert stats["translated"] == 1

    scored_row = conn.execute(
        "SELECT headline_fa, fa_attempts FROM items WHERE id = ?", (scored,)
    ).fetchone()
    assert scored_row["headline_fa"] is not None
    assert scored_row["fa_attempts"] == 0

    unscored_row = conn.execute(
        "SELECT headline_fa, fa_attempts, fa_error FROM items WHERE id = ?",
        (unscored,),
    ).fetchone()
    assert unscored_row["headline_fa"] is None
    # Left exactly as --force found it: still abandoned, not quietly re-armed
    # and then stranded — see rearm()'s docstring on why this matters.
    assert unscored_row["fa_attempts"] == translate.MAX_ATTEMPTS
    assert unscored_row["fa_error"] == "old"


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
        return {"items": [{"n": 1, "headline": "FA-single"}]}

    stats = translate.translate_rows(conn, CFG, GLOSSARY, run)
    # batch, batch retry, then one call per row
    assert len(calls) == 4
    assert stats["translated"] == 2
    heads = {r["headline_fa"] for r in conn.execute("SELECT headline_fa FROM items")}
    assert heads == {"FA-single"}


def test_a_quota_error_aborts_the_batch_without_falling_back_to_singles(tmp_path):
    """The whole point of docs/todo/025: a batch that hits quota must cost
    exactly the one call that discovered it, not the 22 an ordinary failure
    costs (batch, retry, then one call per row)."""
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [(f"Item {i}", 1) for i in range(20)])
    calls = []

    def run(prompt, schema):
        calls.append(prompt)
        raise modelrun.QuotaExhausted("boom: usage limit, upgrade to Pro")

    cfg = {**CFG, "batch_size": 20, "max_batches_per_run": 10}
    stats = translate.translate_rows(conn, cfg, GLOSSARY, run)

    assert len(calls) == 1
    assert stats["quota_exhausted"] is True
    assert stats["translated"] == 0
    assert stats["failed"] == 0


def test_a_quota_error_leaves_fa_attempts_and_fa_failed_at_untouched(tmp_path):
    """The row is not the problem — a billing state is — so nothing about it
    should look like a translation failure, and it must stay eligible to be
    tried again the moment the quota resets."""
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1), ("Two", 2)])

    def run(prompt, schema):
        raise modelrun.QuotaExhausted("usage limit; upgrade to Pro")

    translate.translate_rows(conn, CFG, GLOSSARY, run)

    rows = conn.execute(
        "SELECT fa_attempts, fa_failed_at, fa_error, headline_fa FROM items"
    ).fetchall()
    assert all(r["fa_attempts"] == 0 for r in rows)
    assert all(r["fa_failed_at"] is None for r in rows)
    assert all(r["fa_error"] is None for r in rows)
    assert all(r["headline_fa"] is None for r in rows)
    # And still pending, exactly as before the run — not held back by a
    # backoff or an attempt count that isn't there.
    assert len(translate.pending_rows(conn, 7, 10)) == 2


def test_an_ordinary_batch_failure_still_falls_back_to_singles(tmp_path):
    """The regression guard: QuotaExhausted must not swallow the trade the
    fallback exists for — one bad headline must not poison nineteen good
    ones when the failure is ordinary, not a quota outage."""
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1), ("Two", 2)])
    calls = []

    def run(prompt, schema):
        calls.append(prompt)
        if prompt.count("headline:") > 1:   # the batch, either attempt
            raise modelrun.ModelError("batch failed")
        return {"items": [{"n": 1, "headline": "FA-single"}]}

    stats = translate.translate_rows(conn, CFG, GLOSSARY, run)
    assert len(calls) == 4   # batch, batch retry, then one call per row
    assert stats["translated"] == 2
    assert "quota_exhausted" not in stats


def test_a_quota_error_in_the_events_batch_also_costs_one_call(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    add_event(conn, "e1", "US CPI (MoM)", 24)
    add_event(conn, "e2", "FOMC Statement", 48)
    calls = []

    def run(prompt, schema):
        calls.append(prompt)
        raise modelrun.QuotaExhausted("usage limit — purchase more credits")

    cfg = {**CFG, "batch_size": 20, "max_batches_per_run": 10}
    stats = translate.translate_events(conn, cfg, GLOSSARY, run)
    assert len(calls) == 1
    assert stats["quota_exhausted"] is True
    row = conn.execute(
        "SELECT fa_attempts, fa_failed_at FROM events WHERE id = 'e1'"
    ).fetchone()
    assert row["fa_attempts"] == 0
    assert row["fa_failed_at"] is None


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
        return {"items": [{"n": 1, "headline": "FA-single"}]}

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
        return {"items": [{"n": 1, "headline": "FA1"}]}

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
    """Three runs the row is ELIGIBLE for — the backoff (see BACKOFF_MINUTES)
    is what decides which ticks those are, and the clock is stepped past each
    delay here so this test asks only about the cap."""
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])

    def run(prompt, schema):
        raise modelrun.ModelError("nope")

    for minutes in (0, 20, 90):
        translate.translate_rows(conn, CFG, GLOSSARY, run, now=clock(minutes))
    assert conn.execute("SELECT fa_attempts FROM items").fetchone()[0] == 3
    assert translate.pending_rows(conn, 7, 10, now=clock(24 * 60)) == []


def test_a_row_the_model_omits_counts_as_failed(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1), ("Two", 2)])
    # answer only for entry 1
    stats = translate.translate_rows(
        conn, CFG, GLOSSARY, fake_run(answers={"items": [{"n": 1, "headline": "FA1"}]})
    )
    assert stats["translated"] == 1
    assert stats["failed"] == 1


def test_a_lede_the_model_omits_leaves_lede_fa_null(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    translate.translate_rows(
        conn, CFG, GLOSSARY, fake_run(answers={"items": [{"n": 1, "headline": "FA1"}]})
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
        return {"items": [{"n": 1, "title": "شاخص قیمت مصرف‌کننده آمریکا (ماهانه)"}]}

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
    assert stats == {"translated": 0, "failed": 0, "abandoned": 0}


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


def test_run_translate_stops_the_whole_run_when_rows_hit_quota(tmp_path):
    """docs/todo/025's second half: a quota hit in the rows pass must not go
    on to spend calls in events or docs — every one of them would fail the
    same way, so the run stops rather than rediscovering that three times."""
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    add_event(conn, "e1", "US CPI (MoM)", 24)
    build_state(tmp_path)

    def run(prompt, schema):
        raise modelrun.QuotaExhausted("usage limit; upgrade to Pro")

    stats = translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=run)

    assert stats["quota_exhausted"] is True
    assert stats["rows"]["quota_exhausted"] is True
    # events and docs never ran at all — not "ran and failed"
    assert stats["events"] == {}
    assert stats["docs"] == {}
    assert not (tmp_path / "state" / "stance.fa.md").exists()


def test_run_translate_stops_docs_when_events_hit_quota(tmp_path):
    """Symmetric with the rows case: rows can be clean (nothing pending) while
    events is the pass that meets the outage, and docs must still not run."""
    conn = db.connect(tmp_path / "t.db")
    add_event(conn, "e1", "US CPI (MoM)", 24)
    build_state(tmp_path)

    def run(prompt, schema):
        raise modelrun.QuotaExhausted("usage limit; upgrade to Pro")

    stats = translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=run)

    assert stats["quota_exhausted"] is True
    assert stats["events"]["quota_exhausted"] is True
    assert stats["docs"] == {}
    assert not (tmp_path / "state" / "stance.fa.md").exists()


def test_run_translate_docs_pass_stops_on_its_own_quota_hit(tmp_path):
    """`--only docs` (or events already clean) can be the pass that first
    meets the outage; it must abort itself rather than burn through every
    remaining document."""
    conn = db.connect(tmp_path / "t.db")
    build_state(tmp_path)
    calls = []

    def run(prompt, schema):
        calls.append(prompt)
        raise modelrun.QuotaExhausted("usage limit; upgrade to Pro")

    stats = translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=run, only="docs")

    assert len(calls) == 1   # stance's preamble section; nothing else tried
    assert stats["quota_exhausted"] is True
    assert stats["docs"]["quota_exhausted"] is True


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


def clock(minutes=0):
    """An ISO stamp `minutes` from now; negative is the past."""
    dt = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def always_fails(prompt, schema):
    raise modelrun.ModelError("auth lapsed")


def test_a_failed_row_waits_out_its_backoff_before_being_retried(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    translate.translate_rows(conn, CFG, GLOSSARY, always_fails, now=clock(0))
    assert conn.execute("SELECT fa_attempts FROM items").fetchone()[0] == 1

    calls = []

    def counting(prompt, schema):
        calls.append(prompt)
        raise modelrun.ModelError("auth lapsed")

    # Ten minutes on: still inside the first (15 minute) backoff.
    translate.translate_rows(conn, CFG, GLOSSARY, counting, now=clock(10))
    assert calls == []
    assert conn.execute("SELECT fa_attempts FROM items").fetchone()[0] == 1

    # Twenty minutes on: eligible again, and it spends one more attempt.
    translate.translate_rows(conn, CFG, GLOSSARY, counting, now=clock(20))
    assert calls
    assert conn.execute("SELECT fa_attempts FROM items").fetchone()[0] == 2


def test_three_ticks_in_thirty_minutes_cannot_exhaust_the_attempt_cap(tmp_path):
    """The Friday-evening outage the backoff exists for: without it, the ticks
    at 18:00 / 18:10 / 18:20 each re-selected the same newest rows (nothing
    translated, so the ORDER BY returns an identical set) and drove every one
    of them to the cap inside half an hour."""
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    for minutes in (0, 10, 20):
        translate.translate_rows(conn, CFG, GLOSSARY, always_fails,
                                 now=clock(minutes))
    attempts = conn.execute("SELECT fa_attempts FROM items").fetchone()[0]
    assert attempts < translate.MAX_ATTEMPTS
    # backed off, not abandoned: the second failure buys an hour
    assert translate.pending_rows(conn, 7, 10, now=clock(25)) == []
    assert translate.pending_rows(conn, 7, 10, now=clock(85))


def test_the_backoff_grows_with_the_attempt_count(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("One", 1)])
    conn.execute(
        "UPDATE items SET fa_attempts = 2, fa_failed_at = ? WHERE id = ?",
        (clock(0), one))
    conn.commit()
    assert translate.pending_rows(conn, 7, 10, now=clock(30)) == []
    assert translate.pending_rows(conn, 7, 10, now=clock(90))


def test_a_row_that_never_failed_is_never_backed_off(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    assert translate.pending_rows(conn, 7, 10, now=clock(0))


def test_every_backoff_delay_is_one_a_row_can_actually_reach(tmp_path):
    """A third delay was carried for a long time and never read: `pending_rows`
    filters `fa_attempts < MAX_ATTEMPTS`, so the arm that would use it is only
    reached at `fa_attempts >= 3`, which is already excluded. A tuple with a
    dead entry makes the backoff look longer than it is, which is exactly what
    the comment beside it went on to claim."""
    assert len(translate.BACKOFF_MINUTES) == translate.MAX_ATTEMPTS - 1
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("One", 1)])
    for attempts, delay in enumerate(translate.BACKOFF_MINUTES, start=1):
        conn.execute(
            "UPDATE items SET fa_attempts = ?, fa_failed_at = ? WHERE id = ?",
            (attempts, clock(0), one))
        conn.commit()
        assert translate.pending_rows(
            conn, 7, 10, now=clock(delay - 1)) == [], attempts
        assert translate.pending_rows(conn, 7, 10, now=clock(delay + 1)), attempts


def test_a_total_outage_abandons_a_row_eighty_minutes_in(tmp_path):
    """The real figure on the real cadence. The timer fires every 10 minutes;
    with delays of 15 and 60 the three attempts land at t+0, t+20 and t+80, so
    a row is given up 80 minutes into an outage. That is four times the 20
    minutes it survived before the backoff existed and nowhere near a weekend:
    anything longer still needs --force to bring the rows back."""
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    spent = []
    for minute in range(0, 91, 10):
        before = conn.execute("SELECT fa_attempts FROM items").fetchone()[0]
        translate.translate_rows(conn, CFG, GLOSSARY, always_fails,
                                 now=clock(minute))
        after = conn.execute("SELECT fa_attempts FROM items").fetchone()[0]
        if after > before:
            spent.append(minute)
    assert spent == [0, 20, 80]
    assert conn.execute(
        "SELECT fa_attempts FROM items").fetchone()[0] == translate.MAX_ATTEMPTS
    assert translate.pending_rows(conn, 7, 10, now=clock(10_000)) == []


def test_force_retranslates_a_row_the_model_already_translated(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("One", 1)])
    translate.translate_rows(conn, CFG, GLOSSARY, fake_run())
    conn.execute("UPDATE items SET headline_fa = 'OLD' WHERE id = ?", (one,))
    conn.commit()

    stats = translate.translate_rows(conn, CFG, GLOSSARY, fake_run(), force=True)
    assert stats["translated"] == 1
    assert conn.execute("SELECT headline_fa FROM items").fetchone()[0] != "OLD"


def test_force_never_overwrites_persian_that_came_from_a_flash(tmp_path):
    """Flash Persian is the channel's own editorial wording and it came free.
    The reuse pass owns those rows; --force must not pay to replace them."""
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("One", 1)])
    add_flash(conn, one)
    translate.reuse_flash_persian(conn)

    calls = []
    stats = translate.translate_rows(
        conn, CFG, GLOSSARY, fake_run(calls=calls), force=True)
    assert calls == []
    assert stats["translated"] == 0
    row = conn.execute("SELECT headline_fa, fa_source FROM items").fetchone()
    assert row["headline_fa"] == "تیتر فارسی" and row["fa_source"] == "flash"


def test_force_re_arms_rows_the_attempt_cap_abandoned(tmp_path):
    """The spec, verbatim: a row at 3 attempts is reset by --force and retried
    once more, so an operator clearing a known-bad state does not have to edit
    the database."""
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("One", 1)])
    conn.execute(
        "UPDATE items SET fa_attempts = ?, fa_error = 'auth lapsed',"
        " fa_failed_at = ? WHERE id = ?",
        (translate.MAX_ATTEMPTS, clock(-5), one))
    conn.commit()
    assert translate.pending_rows(conn, 7, 10) == []      # abandoned today

    stats = translate.translate_rows(conn, CFG, GLOSSARY, fake_run(), force=True)
    assert stats["translated"] == 1
    row = conn.execute(
        "SELECT headline_fa, fa_attempts, fa_error FROM items").fetchone()
    assert row["headline_fa"].startswith("FA")
    assert row["fa_attempts"] == 0 and row["fa_error"] is None


def test_force_re_arms_and_retranslates_events(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    add_event(conn, "e1", "US CPI (MoM)", 24)
    conn.execute(
        "UPDATE events SET title_fa = 'OLD', fa_attempts = ? WHERE id = 'e1'",
        (translate.MAX_ATTEMPTS,))
    conn.commit()

    def run(prompt, schema):
        return {"items": [{"n": 1, "title": "NEW"}]}

    stats = translate.translate_events(conn, CFG, GLOSSARY, run, force=True)
    assert stats["translated"] == 1
    row = conn.execute("SELECT title_fa, fa_attempts FROM events").fetchone()
    assert row["title_fa"] == "NEW" and row["fa_attempts"] == 0


def test_run_translate_force_reaches_the_rows_pass(tmp_path):
    """--force was wired only into the docs pass: an outage that abandoned the
    row backlog had no operator remedy short of editing the database."""
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("One", 1)])
    conn.execute("UPDATE items SET fa_attempts = ? WHERE id = ?",
                 (translate.MAX_ATTEMPTS, one))
    conn.commit()
    stats = translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=fake_run(), force=True)
    assert stats["rows"]["translated"] == 1


def counting_doc_run(calls, prefix="FA:"):
    def run(prompt, schema):
        calls.append(prompt)
        return {"text": prefix + prompt.split("---\n", 1)[1]}
    return run


def test_the_docs_pass_stops_at_the_per_run_call_ceiling(tmp_path):
    """Rows and events have max_batches_per_run; documents had no ceiling at
    all, so one refused document cost a call every tick forever and the first
    run after a deploy made one serial call per historical prediction line."""
    build_state(tmp_path)
    calls = []
    stats = translate.translate_docs(
        tmp_path, {**DOC_CFG, "max_doc_calls_per_run": 2}, GLOSSARY,
        counting_doc_run(calls))
    assert len(calls) == 2
    assert stats["translated"] == 2
    assert stats["skipped"]


def test_the_docs_pass_picks_the_rest_up_on_the_next_tick(tmp_path):
    build_state(tmp_path)
    cfg = {**DOC_CFG, "max_doc_calls_per_run": 2}
    for _ in range(6):
        translate.translate_docs(tmp_path, cfg, GLOSSARY, doc_run())
    for rel in ("state/stance.fa.md", "state/playbook.fa.md",
                "state/watchlist.fa.yaml", "state/predictions.fa.jsonl",
                "reports/2026/09/2026-09-12-brief.fa.md"):
        assert (tmp_path / rel).exists(), rel
    calls = []
    translate.translate_docs(tmp_path, cfg, GLOSSARY, counting_doc_run(calls))
    assert calls == []          # everything current: the ceiling costs nothing


def test_a_predictions_backlog_cannot_run_away_with_a_tick(tmp_path):
    """One serial model call per line of an append-only file, with
    timeout_seconds 180, is how the unit gets pinned for hours."""
    build_state(tmp_path)
    (tmp_path / "state" / "predictions.jsonl").write_text(
        "".join(json.dumps({"id": f"p{i}", "claim": f"Claim {i}."}) + "\n"
                for i in range(150)),
        encoding="utf-8")
    calls = []
    translate.translate_docs(
        tmp_path, {**DOC_CFG, "max_doc_calls_per_run": 4}, GLOSSARY,
        counting_doc_run(calls))
    assert len(calls) == 4


def test_no_ceiling_configured_means_no_ceiling(tmp_path):
    """The key is optional: a config without it behaves as it did before."""
    build_state(tmp_path)
    calls = []
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY,
                             counting_doc_run(calls))
    assert len(calls) > 4


def test_the_stance_sidecar_carries_the_whole_source_hash(tmp_path):
    """The front-matter shape is stated in the spec "exactly so the reader and
    the writer cannot disagree", and PR 2's readStanceFa returns null when
    meta.src_hash does not match sha256(stance.md). An empty top-level hash
    mismatches every time, so the Persian stance would never render at all.
    The per-section hashes are a different question and stay as they are."""
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"

    translate.translate_stance(src, side, GLOSSARY, doc_run())

    meta, _ = tt.parse_front_matter(side.read_text(encoding="utf-8"))
    assert meta["src_hash"] == tt.src_hash(STANCE_MD)
    assert meta["translator"] == "codex"


def test_a_rewritten_stance_restamps_the_whole_source_hash(tmp_path):
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))

    changed = STANCE_MD.replace("Gold is bid.", "Gold is offered.")
    src.write_text(changed, encoding="utf-8")
    translate.translate_stance(src, side, GLOSSARY, doc_run("NEW:"))

    meta, _ = tt.parse_front_matter(side.read_text(encoding="utf-8"))
    assert meta["src_hash"] == tt.src_hash(changed)


def test_an_emptied_stance_section_still_rewrites_the_sidecar(tmp_path):
    """`if translated:` skipped the rewrite on a structural-only change. A
    brief that empties a section translates nothing, so the sidecar kept a
    stale body — and, when a section is dropped, a stale section COUNT. The
    panel matches sidecar bodies to source sections by ORDER, so a count
    mismatch degrades the whole Stance panel to English."""
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))
    before = side.read_text(encoding="utf-8")

    emptied = STANCE_MD.replace("- A hot CPI print.\n", "")
    src.write_text(emptied, encoding="utf-8")
    stats = translate.translate_stance(src, side, GLOSSARY, doc_run())

    assert stats == {"translated": 0, "failed": 0, "abandoned": 0}
    after = side.read_text(encoding="utf-8")
    assert after != before
    sections = tt.parse_stance_sidecar(after)
    assert [h for h, _, _ in sections] == ["", "## View", "## What flips me"]
    assert sections[2][2].strip() == ""          # the emptied body followed
    meta, _ = tt.parse_front_matter(after)
    assert meta["src_hash"] == tt.src_hash(emptied)


def test_a_dropped_stance_section_shrinks_the_sidecar(tmp_path):
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))

    shorter = STANCE_MD.split("## What flips me")[0]
    src.write_text(shorter, encoding="utf-8")
    stats = translate.translate_stance(src, side, GLOSSARY, doc_run())

    assert stats["translated"] == 0              # every surviving body is current
    sections = tt.parse_stance_sidecar(side.read_text(encoding="utf-8"))
    assert [h for h, _, _ in sections] == ["", "## View"]


def test_a_stance_sidecar_missing_its_source_hash_is_restamped(tmp_path):
    """A sidecar written before the front-matter hash was filled in is
    otherwise current, so nothing would ever translate — and nothing would
    ever correct the hash either."""
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run())
    body = side.read_text(encoding="utf-8")
    side.write_text(body.replace(f"src_hash: {tt.src_hash(STANCE_MD)}",
                                 "src_hash: ", 1), encoding="utf-8")

    calls = []
    stats = translate.translate_stance(
        src, side, GLOSSARY, counting_doc_run(calls))
    assert stats["translated"] == 0 and calls == []
    meta, _ = tt.parse_front_matter(side.read_text(encoding="utf-8"))
    assert meta["src_hash"] == tt.src_hash(STANCE_MD)


def test_a_removed_watchlist_theme_leaves_the_sidecar(tmp_path):
    src = tmp_path / "watchlist.yaml"
    entries = [{"theme": "a", "why": "One.", "since": "2026-08-01"},
               {"theme": "b", "why": "Two.", "since": "2026-08-01"}]
    src.write_text(yaml.safe_dump({"watchlist": entries}), encoding="utf-8")
    side = tmp_path / "watchlist.fa.yaml"
    translate.translate_watchlist(src, side, GLOSSARY, doc_run())

    src.write_text(yaml.safe_dump({"watchlist": entries[:1]}), encoding="utf-8")
    stats = translate.translate_watchlist(src, side, GLOSSARY, doc_run())

    assert stats["translated"] == 0
    themes = [e["theme"] for e in
              yaml.safe_load(side.read_text(encoding="utf-8"))["watchlist"]]
    assert themes == ["a"]


def test_translate_watchlist_leaves_the_sidecar_alone_when_everything_fails(tmp_path):
    src = tmp_path / "watchlist.yaml"
    src.write_text(yaml.safe_dump({"watchlist": [
        {"theme": "a", "why": "One.", "since": "2026-08-01"}]}),
        encoding="utf-8")
    side = tmp_path / "watchlist.fa.yaml"
    translate.translate_watchlist(src, side, GLOSSARY, doc_run("OLD:"))
    before = side.read_text(encoding="utf-8")

    src.write_text(yaml.safe_dump({"watchlist": [
        {"theme": "a", "why": "One changed.", "since": "2026-08-01"}]}),
        encoding="utf-8")

    def failing(prompt, schema):
        raise modelrun.ModelError("nope")

    assert translate.translate_watchlist(
        src, side, GLOSSARY, failing)["failed"] == 1
    assert side.read_text(encoding="utf-8") == before


def test_a_removed_prediction_leaves_the_sidecar(tmp_path):
    src = tmp_path / "predictions.jsonl"
    lines = [json.dumps({"id": "p1", "claim": "One."}),
             json.dumps({"id": "p2", "claim": "Two."})]
    src.write_text("\n".join(lines) + "\n", encoding="utf-8")
    side = tmp_path / "predictions.fa.jsonl"
    translate.translate_predictions(src, side, GLOSSARY, doc_run())

    src.write_text(lines[0] + "\n", encoding="utf-8")
    stats = translate.translate_predictions(src, side, GLOSSARY, doc_run())

    assert stats["translated"] == 0
    ids = [json.loads(l)["id"] for l in
           side.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert ids == ["p1"]


def test_translate_predictions_leaves_the_sidecar_alone_when_everything_fails(tmp_path):
    src = tmp_path / "predictions.jsonl"
    src.write_text(json.dumps({"id": "p1", "claim": "One."}) + "\n",
                   encoding="utf-8")
    side = tmp_path / "predictions.fa.jsonl"
    translate.translate_predictions(src, side, GLOSSARY, doc_run("OLD:"))
    before = side.read_text(encoding="utf-8")

    src.write_text(json.dumps({"id": "p1", "claim": "One changed."}) + "\n",
                   encoding="utf-8")

    def failing(prompt, schema):
        raise modelrun.ModelError("nope")

    assert translate.translate_predictions(
        src, side, GLOSSARY, failing)["failed"] == 1
    assert side.read_text(encoding="utf-8") == before


def test_force_is_not_bounded_by_the_per_run_document_ceiling(tmp_path):
    """Two fixes collided. Under --force the hash check is skipped but the
    budget still applied, and a budget-refused unit was written back carrying
    its CURRENT hash — so the next ordinary tick saw it as up to date and never
    revisited it. Measured with a ceiling of 3 and 7 units: one --force did the
    first 3, reported the rest "deferred to the next tick", the next ordinary
    tick did nothing, and three further --force runs re-did the same first 3
    forever. The spec's promise is the other way round: "changing the glossary
    does not retranslate anything by itself; jamasp translate --force does"."""
    build_state(tmp_path)
    units = len(tt.split_sections(STANCE_MD)) + 4   # + playbook, watchlist,
    assert units == 7                               #   predictions, report

    calls = []
    stats = translate.translate_docs(
        tmp_path, {**DOC_CFG, "max_doc_calls_per_run": 3}, GLOSSARY,
        counting_doc_run(calls), force=True)

    assert len(calls) == units          # every unit, not the first three
    assert stats["translated"] == units
    assert stats["skipped"] == 0        # nothing deferred, so claim nothing
    # The report is translated last of all, so its sidecar is the tail of the
    # pass that repeat --force runs used never to reach.
    for rel in ("state/stance.fa.md", "state/playbook.fa.md",
                "state/watchlist.fa.yaml", "state/predictions.fa.jsonl",
                "reports/2026/09/2026-09-12-brief.fa.md"):
        assert (tmp_path / rel).exists(), rel


def test_force_re_glosses_every_document_it_offers(tmp_path):
    """The operator action this exists for: edit config/glossary.fa.yaml, run
    --force once, and get the whole state tree re-glossed in that run — not the
    first `max_doc_calls_per_run` units of it.

    Reports already carrying a sidecar are not among them, and that is a
    separate, deliberate rule: `new_reports` offers only reports with no
    sidecar yet (spec decision 18), which --force does not widen."""
    build_state(tmp_path)
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, doc_run("OLD:"))

    calls = []
    stats = translate.translate_docs(
        tmp_path, {**DOC_CFG, "max_doc_calls_per_run": 3}, GLOSSARY,
        counting_doc_run(calls, "NEW:"), force=True)

    assert len(calls) == 6              # 3 stance sections + the other 3 docs
    assert stats["translated"] == 6 and stats["skipped"] == 0
    for rel in ("state/stance.fa.md", "state/playbook.fa.md",
                "state/watchlist.fa.yaml", "state/predictions.fa.jsonl"):
        body = (tmp_path / rel).read_text(encoding="utf-8")
        assert "NEW:" in body and "OLD:" not in body, rel


def test_the_ordinary_tick_still_stops_at_the_ceiling_and_converges(tmp_path):
    """What the ceiling was added for, kept: an unattended tick stays bounded,
    and the deferred backlog still drains over subsequent ticks."""
    build_state(tmp_path)
    cfg = {**DOC_CFG, "max_doc_calls_per_run": 3}
    calls = []
    stats = translate.translate_docs(
        tmp_path, cfg, GLOSSARY, counting_doc_run(calls))
    assert len(calls) == 3 and stats["skipped"] == 4

    for _ in range(3):
        translate.translate_docs(tmp_path, cfg, GLOSSARY, doc_run())
    after = []
    assert translate.translate_docs(
        tmp_path, cfg, GLOSSARY, counting_doc_run(after))["skipped"] == 0
    assert after == []


def test_a_stance_sidecar_holding_english_does_not_match_the_source(tmp_path):
    """A section that fails with no previous Persian lands in the sidecar as
    its ENGLISH body under an empty per-section hash. The whole-file hash in
    the front matter must therefore NOT match stance.md: PR 2's readStanceFa
    treats a mismatch as no sidecar and falls back to English wholesale with
    the EN marker, whereas a matching hash would render English as Persian
    with no marker at all. It self-heals on the next successful tick — but not
    before the panel has shown the wrong thing without saying so."""
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"

    def one_section_fails(prompt, schema):
        if "CPI" in prompt:
            raise modelrun.ModelError("flips boom")
        return {"text": "FA:" + prompt.split("---\n", 1)[1]}

    stats = translate.translate_stance(src, side, GLOSSARY, one_section_fails)
    assert stats == {"translated": 2, "failed": 1, "abandoned": 0}

    text = side.read_text(encoding="utf-8")
    assert "- A hot CPI print." in text          # the English body really is there
    meta, _ = tt.parse_front_matter(text)
    assert meta["src_hash"] != tt.src_hash(STANCE_MD)

    # And the healthy case still stamps the real hash, so the Persian stance
    # renders at all — the whole point of writing it in the first place.
    stats = translate.translate_stance(src, side, GLOSSARY, doc_run())
    assert stats == {"translated": 1, "failed": 0, "abandoned": 0}
    meta, _ = tt.parse_front_matter(side.read_text(encoding="utf-8"))
    assert meta["src_hash"] == tt.src_hash(STANCE_MD)


def test_a_budget_deferred_stance_section_does_not_match_the_source(tmp_path):
    """Same degraded state by the other route: an ordinary tick that runs out
    of document calls before it reaches a section with no Persian yet."""
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"

    stats = translate.translate_stance(src, side, GLOSSARY, doc_run(),
                                       budget=translate.DocBudget(1))
    assert stats == {"translated": 1, "failed": 0, "abandoned": 0}
    meta, _ = tt.parse_front_matter(side.read_text(encoding="utf-8"))
    assert meta["src_hash"] != tt.src_hash(STANCE_MD)

    translate.translate_stance(src, side, GLOSSARY, doc_run(),
                               budget=translate.DocBudget(5))
    meta, _ = tt.parse_front_matter(side.read_text(encoding="utf-8"))
    assert meta["src_hash"] == tt.src_hash(STANCE_MD)


def test_a_stance_sidecar_of_stale_persian_still_matches_the_source(tmp_path):
    """The line between the two degraded states, and it is deliberate. A
    failed section that HAS previous Persian keeps it, under its old
    per-section hash; the sidecar's sections still match the source in count
    and order, so the panel renders Persian with one stale section rather than
    dropping the whole Stance panel to English. Only an English body — an
    empty per-section hash — breaks the top-level hash."""
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))

    changed = STANCE_MD.replace(
        "Gold is bid.", "Gold is offered."
    ).replace("- A hot CPI print.", "- A cooling CPI print.")
    src.write_text(changed, encoding="utf-8")

    def flips_fails(prompt, schema):
        if "cooling" in prompt:
            raise modelrun.ModelError("flips boom")
        return {"text": "NEW:" + prompt.split("---\n", 1)[1]}

    assert translate.translate_stance(
        src, side, GLOSSARY, flips_fails) == {"translated": 1, "failed": 1, "abandoned": 0}
    text = side.read_text(encoding="utf-8")
    assert "OLD:" in text                       # stale Persian, not English
    meta, _ = tt.parse_front_matter(text)
    assert meta["src_hash"] == tt.src_hash(changed)


FLOOR_CFG = {**CFG, "translate_from": "2026-09-20"}


def test_floor_for_pins_the_window_when_translate_from_is_later():
    # The rolling window would reach back 7 days; the floor is 1 day back, so
    # the floor wins and history is out of scope.
    assert translate.floor_for(
        FLOOR_CFG, 7, "2026-09-21T12:00:00Z") == "2026-09-20T00:00:00Z"


def test_floor_for_keeps_the_window_when_it_is_the_later_of_the_two():
    # An old floor must not WIDEN the window past window_days, or clearing a
    # backfill would silently re-open one.
    assert translate.floor_for(
        {**CFG, "translate_from": "2020-01-01"}, 7,
        "2026-09-21T12:00:00Z") == translate._since(7, "2026-09-21T12:00:00Z")


def test_floor_for_falls_back_to_the_plain_window_when_unset():
    for cfg in (CFG, {**CFG, "translate_from": ""}, {**CFG, "translate_from": None}):
        assert translate.floor_for(cfg, 7, "2026-09-21T12:00:00Z") == \
            translate._since(7, "2026-09-21T12:00:00Z")


def test_floor_for_accepts_an_exact_moment_not_only_a_date():
    assert translate.floor_for(
        {**CFG, "translate_from": "2026-09-20T13:45:00Z"}, 7,
        "2026-09-21T12:00:00Z") == "2026-09-20T13:45:00Z"


def test_rows_pass_skips_history_behind_the_floor(tmp_path):
    """The whole point: an old item is never selected once the floor is set."""
    conn = db.connect(tmp_path / "t.db")
    old, fresh = seed(conn, [("Ancient news", 24 * 5), ("Todays news", 1)])
    ids = [r["id"] for r in translate.pending_rows(
        conn, 7, 10, since=translate.floor_for(FLOOR_CFG, 7))]
    assert fresh in ids
    assert old not in ids, "an item behind translate_from must never be selected"


def test_rows_pass_still_sees_history_with_no_floor(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    old, fresh = seed(conn, [("Ancient news", 24 * 5), ("Todays news", 1)])
    ids = [r["id"] for r in translate.pending_rows(conn, 7, 10)]
    assert {old, fresh} <= set(ids)


def test_floor_for_tolerates_an_unquoted_yaml_date():
    """`translate_from: 2026-09-20` with no quotes yields a datetime.date.

    An operator editing settings.yaml will write it unquoted sooner or later,
    and a config typo must not take the pass down at the first tick.
    """
    import datetime as _dt
    assert translate.floor_for(
        {**CFG, "translate_from": _dt.date(2026, 9, 20)}, 7,
        "2026-09-21T12:00:00Z") == "2026-09-20T00:00:00Z"


# ---------------------------------------------------------------- large docs

def big_brief(sections=6, paras=6):
    """A brief shaped like the real ones, comfortably over the threshold.

    The live 2026-09-16 brief was 21,728 bytes across six `## ` sections, the
    largest 8,434; this is the same shape at a size no threshold accident can
    make small.
    """
    out = ["# Jamasp Brief — 2026-09-16\n\nGold at 3,681.40.\n\n"]
    for s in range(sections):
        out.append(f"## Section {s}\n\n")
        for p in range(paras):
            out.append(f"Paragraph {p} of section {s}. " * 12 + "\n\n")
    return "".join(out)


def test_a_large_document_is_translated_in_pieces(tmp_path):
    """21,728 bytes in one call timed out after 180s on the live host; 11,362
    and 11,455 succeeded. Nothing above ~12KB could ever finish."""
    src = tmp_path / "brief.md"
    src.write_text(big_brief(), encoding="utf-8")
    calls = []
    result = translate.translate_document(
        src, tmp_path / "brief.fa.md", GLOSSARY, counting_doc_run(calls),
        chunk_bytes=8000)
    assert result["translated"] == 1
    assert len(calls) > 1
    for prompt in calls:
        payload = prompt.split("---\n", 1)[1]
        assert len(payload.encode("utf-8")) <= 8000


def test_a_chunked_document_keeps_its_structure_exactly(tmp_path):
    """Only the prose may differ. Heading text, heading order and the
    preamble before the first heading come back byte-identical."""
    src = tmp_path / "brief.md"
    source = big_brief()
    src.write_text(source, encoding="utf-8")
    sidecar = tmp_path / "brief.fa.md"
    translate.translate_document(src, sidecar, GLOSSARY, doc_run(),
                                 chunk_bytes=8000)
    _, body = tt.parse_front_matter(sidecar.read_text(encoding="utf-8"))
    assert ([h for h, _ in tt.split_sections(body)]
            == [h for h, _ in tt.split_sections(source)])
    assert "# Jamasp Brief" in body
    assert body.count("FA:") > 1          # really was assembled from pieces


def test_a_small_document_still_takes_a_single_call(tmp_path):
    """Chunking a 2KB playbook into one chunk is pointless overhead and more
    failure surface, so the threshold gates it."""
    src = tmp_path / "playbook.md"
    src.write_text("## A\n\nShort.\n\n## B\n\nAlso short.\n", encoding="utf-8")
    calls = []
    translate.translate_document(src, tmp_path / "playbook.fa.md", GLOSSARY,
                                 counting_doc_run(calls), chunk_bytes=8000)
    assert len(calls) == 1
    assert "## A" in calls[0]             # the whole document, headings and all


def test_the_chunk_threshold_comes_from_config(tmp_path):
    """Not a magic number: the key moves the boundary in both directions."""
    src = tmp_path / "brief.md"
    src.write_text(big_brief(sections=2), encoding="utf-8")

    def calls_at(limit):
        calls = []
        sidecar = tmp_path / f"brief.{limit}.fa.md"
        translate.translate_docs(
            tmp_path, {**DOC_CFG, "doc_chunk_bytes": limit}, GLOSSARY,
            counting_doc_run(calls))
        sidecar.unlink(missing_ok=True)
        return calls

    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    (tmp_path / "state" / "playbook.md").write_text(
        big_brief(sections=2), encoding="utf-8")
    assert len(calls_at(100_000)) == 1
    (tmp_path / "state" / "playbook.fa.md").unlink()
    assert len(calls_at(1_000)) > 1


# ------------------------------------------------------- per-document give-up

def failing_doc_run(calls):
    def run(prompt, schema):
        calls.append(prompt)
        raise modelrun.ModelError("codex refused this document")
    return run


def one_doc(root, text="Playbook.\n"):
    """A tree whose only translatable unit is the playbook."""
    (root / "state").mkdir(parents=True, exist_ok=True)
    (root / "state" / "playbook.md").write_text(text, encoding="utf-8")


def test_a_document_that_keeps_failing_stops_being_attempted(tmp_path):
    """docs/todo/019: with no per-document cap a refused document cost a call
    every tick, ~144 a day, forever."""
    conn = db.connect(tmp_path / "t.db")
    one_doc(tmp_path)
    calls = []
    for minutes in (0, 20, 90, 200, 400):
        translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY,
                                 failing_doc_run(calls), now=clock(minutes),
                                 conn=conn)
    assert len(calls) == translate.MAX_DOC_ATTEMPTS


def test_a_failed_document_waits_out_its_backoff_before_retrying(tmp_path):
    """Same reason rows got one: three 10-minute ticks would otherwise walk a
    document to the cap 20 minutes into a transient outage."""
    conn = db.connect(tmp_path / "t.db")
    one_doc(tmp_path)
    calls = []
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY,
                             failing_doc_run(calls), now=clock(0), conn=conn)
    assert len(calls) == 1
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY,
                             failing_doc_run(calls), now=clock(10), conn=conn)
    assert len(calls) == 1                # still inside the 15-minute backoff
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY,
                             failing_doc_run(calls), now=clock(20), conn=conn)
    assert len(calls) == 2


def test_an_abandoned_document_is_counted_apart_from_a_failure(tmp_path):
    """"3 documents were skipped because they keep failing" must be legible
    as something other than "3 documents failed this run"."""
    conn = db.connect(tmp_path / "t.db")
    one_doc(tmp_path)
    for minutes in (0, 20, 90):
        stats = translate.translate_docs(
            tmp_path, DOC_CFG, GLOSSARY, always_fails, now=clock(minutes),
            conn=conn)
        assert stats == {"translated": 0, "failed": 1, "abandoned": 0,
                         "skipped": 0}
    stats = translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, always_fails,
                                     now=clock(200), conn=conn)
    assert stats["failed"] == 0
    assert stats["abandoned"] == 1


def test_force_re_arms_an_abandoned_document(tmp_path):
    """The same escape hatch --force gives an abandoned row."""
    conn = db.connect(tmp_path / "t.db")
    one_doc(tmp_path)
    for minutes in (0, 20, 90):
        translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, always_fails,
                                 now=clock(minutes), conn=conn)
    calls = []
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY,
                             counting_doc_run(calls), now=clock(200),
                             force=True, conn=conn)
    assert len(calls) == 1
    assert (tmp_path / "state" / "playbook.fa.md").exists()
    assert conn.execute(
        "SELECT COUNT(*) FROM doc_translations").fetchone()[0] == 0


def test_rewriting_an_abandoned_document_re_arms_it(tmp_path):
    """stance.md is rewritten at the end of every run. Abandoning a unit for
    good would outlive the English that earned the abandonment."""
    conn = db.connect(tmp_path / "t.db")
    one_doc(tmp_path)
    for minutes in (0, 20, 90):
        translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, always_fails,
                                 now=clock(minutes), conn=conn)
    (tmp_path / "state" / "playbook.md").write_text("Rewritten.\n",
                                                    encoding="utf-8")
    calls = []
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY,
                             counting_doc_run(calls), now=clock(200),
                             conn=conn)
    assert len(calls) == 1


def test_a_document_that_succeeds_leaves_no_give_up_state(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    one_doc(tmp_path)
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, always_fails,
                             now=clock(0), conn=conn)
    assert conn.execute(
        "SELECT COUNT(*) FROM doc_translations").fetchone()[0] == 1
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, doc_run(),
                             now=clock(20), conn=conn)
    assert conn.execute(
        "SELECT COUNT(*) FROM doc_translations").fetchone()[0] == 0


def test_a_quota_error_never_counts_a_document_attempt(tmp_path):
    """A quota outage is not "this document is bad". It must abort the run
    without spending the document's attempts (docs/todo/025)."""
    conn = db.connect(tmp_path / "t.db")
    one_doc(tmp_path)

    def out_of_quota(prompt, schema):
        raise modelrun.QuotaExhausted("usage limit")

    for minutes in (0, 20, 90, 200):
        stats = translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY,
                                         out_of_quota, now=clock(minutes),
                                         conn=conn)
        assert stats["quota_exhausted"] is True
    assert conn.execute(
        "SELECT COUNT(*) FROM doc_translations").fetchone()[0] == 0


def test_run_translate_wires_the_document_ledger(tmp_path):
    """The production path, not just translate_docs directly: without the
    connection reaching the docs pass there is no cap at all."""
    conn = db.connect(tmp_path / "t.db")
    one_doc(tmp_path)
    calls = []
    for minutes in (0, 20, 90, 200, 400):
        translate.run_translate(
            conn, {"translate": {**DOC_CFG, "scored_only": False}},
            root=tmp_path, glossary=GLOSSARY, run=failing_doc_run(calls),
            now=clock(minutes), only="docs")
    assert len(calls) == translate.MAX_DOC_ATTEMPTS


def test_every_document_kind_is_bounded_by_the_cap(tmp_path):
    """Stance sections, watchlist entries and prediction lines fail the same
    way a report does, and each is a unit of its own."""
    conn = db.connect(tmp_path / "t.db")
    build_state(tmp_path)
    for minutes in (0, 20, 90):
        translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, always_fails,
                                 now=clock(minutes), conn=conn)
    units = {r[0] for r in conn.execute("SELECT unit FROM doc_translations")}
    assert "state/playbook.md" in units
    assert "reports/2026/09/2026-09-12-brief.md" in units
    assert any(u.startswith("state/stance.md#") for u in units)
    assert "state/watchlist.yaml#t" in units
    assert "state/predictions.jsonl#p1" in units

    calls = []
    stats = translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY,
                                     failing_doc_run(calls), now=clock(200),
                                     conn=conn)
    assert calls == []
    assert stats["abandoned"] == len(units)


# ----------------------------------------------- end to end, real subprocess

def oversize_settings(tmp_path, **overrides):
    return {"translate": {
        "cmd": [sys.executable, "tests/fake_codex.py"],
        "protocol": "codex", "timeout_seconds": 60,
        "window_days": 7, "batch_size": 20, "max_batches_per_run": 6,
        "reports_since": "2026-09-01", "scored_only": False,
        **overrides}}


def test_a_report_the_translator_refuses_whole_succeeds_in_pieces(
    tmp_path, monkeypatch
):
    """The production failure, end to end through the real codex protocol
    against a translator that refuses exactly what the real one refused:
    2026-09-16-brief.md, 21,728 bytes, timed out after 180s while 11,362 and
    11,455-byte briefs went through."""
    monkeypatch.setenv("FAKE_CODEX_MODE", "oversize")
    conn = db.connect(tmp_path / "t.db")
    reports = tmp_path / "reports" / "2026" / "09"
    reports.mkdir(parents=True)
    source = big_brief(sections=7, paras=10)
    assert len(source.encode("utf-8")) > 20_000
    (reports / "2026-09-16-brief.md").write_text(source, encoding="utf-8")

    stats = translate.run_translate(
        conn, oversize_settings(tmp_path), root=tmp_path, glossary=GLOSSARY,
        only="docs")
    assert stats["docs"] == {"translated": 1, "failed": 0, "abandoned": 0,
                             "skipped": 0}

    sidecar = reports / "2026-09-16-brief.fa.md"
    meta, body = tt.parse_front_matter(sidecar.read_text(encoding="utf-8"))
    assert meta["src_hash"] == tt.src_hash(source)
    assert ([h for h, _ in tt.split_sections(body)]
            == [h for h, _ in tt.split_sections(source)])


def test_the_same_report_still_fails_when_chunking_is_switched_off(
    tmp_path, monkeypatch
):
    """Pins the fake's teeth. Without this, the test above would pass even if
    `doc_chunk_bytes` did nothing at all."""
    monkeypatch.setenv("FAKE_CODEX_MODE", "oversize")
    conn = db.connect(tmp_path / "t.db")
    reports = tmp_path / "reports" / "2026" / "09"
    reports.mkdir(parents=True)
    (reports / "2026-09-16-brief.md").write_text(
        big_brief(sections=7, paras=10), encoding="utf-8")

    stats = translate.run_translate(
        conn, oversize_settings(tmp_path, doc_chunk_bytes=10_000_000),
        root=tmp_path, glossary=GLOSSARY, only="docs")
    assert stats["docs"]["failed"] == 1
    assert not (reports / "2026-09-16-brief.fa.md").exists()
