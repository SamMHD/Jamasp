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
