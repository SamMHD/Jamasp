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
