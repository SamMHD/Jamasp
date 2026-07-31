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
