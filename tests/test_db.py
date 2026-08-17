import sqlite3

from jamasp import db


def test_connect_creates_schema(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    tables = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"items", "prices", "extract_cache", "source_errors"} <= tables


def test_connect_is_idempotent(tmp_path):
    p = tmp_path / "t.db"
    db.connect(p).close()
    conn = db.connect(p)  # must not raise on existing schema
    conn.execute("INSERT INTO prices VALUES ('XAUUSD', '2026-07-31T00:00:00Z', 3400.0)")
    conn.commit()


def test_utcnow_format():
    ts = db.utcnow()
    assert len(ts) == 20 and ts.endswith("Z") and ts[10] == "T"


def test_phase2_tables_exist(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    for table in ("wakeups", "events", "agent_runs", "meta"):
        assert conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone(), f"missing table {table}"


def test_phase2_schema_migrates_existing_db(tmp_path):
    # simulate a phase-1 db: connect (creates old+new tables), then drop new ones
    p = tmp_path / "j.db"
    conn = db.connect(p)
    conn.executescript("DROP TABLE wakeups; DROP TABLE events; DROP TABLE agent_runs; DROP TABLE meta;")
    conn.close()
    conn = db.connect(p)  # re-connect must recreate them
    assert conn.execute("SELECT COUNT(*) FROM wakeups").fetchone()[0] == 0


def test_busy_timeout_set(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000


def test_meta_helpers(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    assert db.get_meta(conn, "last_ingest_at") is None
    db.set_meta(conn, "last_ingest_at", "2026-07-31T05:00:00Z")
    db.set_meta(conn, "last_ingest_at", "2026-07-31T05:15:00Z")  # upsert
    assert db.get_meta(conn, "last_ingest_at") == "2026-07-31T05:15:00Z"


def test_connect_creates_flash_tables(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    names = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"flashes", "flash_items"} <= names


def test_flashes_requires_message_id(tmp_path):
    import sqlite3

    import pytest

    conn = db.connect(tmp_path / "t.db")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO flashes (id, created_at, updated_at, title_en, title_fa,"
            " summary_fa, impact_fa, url, message_id, status)"
            " VALUES ('a','t','t','en','fa','s','i','https://e/1', NULL, 'sent')"
        )


def test_connect_adds_missing_flash_item_columns(tmp_path):
    # connect() only runs CREATE TABLE IF NOT EXISTS, so a database created
    # before tiering never gains the new columns without an explicit step —
    # and the deployed one is 9MB of live history that can't be recreated.
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript(
        "CREATE TABLE flash_items ("
        " item_id TEXT PRIMARY KEY, flash_id TEXT, state TEXT NOT NULL, ts TEXT NOT NULL);"
    )
    old.execute(
        "INSERT INTO flash_items (item_id, flash_id, state, ts)"
        " VALUES ('i1', NULL, 'posted', '2026-08-01T00:00:00Z')"
    )
    old.commit()
    old.close()

    conn = db.connect(path)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(flash_items)")}
    assert {"tier", "rollup_id"} <= cols
    # the pre-existing row survives, with NULLs in the new columns
    row = conn.execute("SELECT * FROM flash_items WHERE item_id = 'i1'").fetchone()
    assert row["state"] == "posted" and row["tier"] is None
    conn.close()

    # idempotent: a second connect must not fail on duplicate columns
    again = db.connect(path)
    assert {"tier", "rollup_id"} <= {
        r["name"] for r in again.execute("PRAGMA table_info(flash_items)")
    }


def test_connect_creates_rollups_table(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(rollups)")}
    assert {"id", "created_at", "text_fa", "message_id", "status"} <= cols
