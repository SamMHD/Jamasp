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
    assert flash.retire_stale(conn, 6) == 1
    row = conn.execute(
        "SELECT state FROM flash_items WHERE item_id = ?", (old,)
    ).fetchone()
    assert row["state"] == "skipped_stale"
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (fresh,)
    ).fetchone()["c"] == 0
    # idempotent: a second pass finds nothing new
    assert flash.retire_stale(conn, 6) == 0


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
