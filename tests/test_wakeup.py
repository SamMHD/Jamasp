import pytest
from click.testing import CliRunner

from jamasp import db, wakeup
from jamasp.cli import main


def test_add_normalizes_and_lists(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    wid = wakeup.add(conn, "2026-08-01T18:30:00+04:00", "deepdive", "read FOMC minutes")
    rows = wakeup.list_open(conn)
    assert [r["id"] for r in rows] == [wid]
    assert rows[0]["due_at"] == "2026-08-01T14:30:00Z"  # normalized to UTC
    assert rows[0]["status"] == "pending"


def test_add_rejects_bad_input(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    with pytest.raises(ValueError):
        wakeup.add(conn, "tomorrow evening", "deepdive", "t")
    with pytest.raises(ValueError):
        wakeup.add(conn, "2026-08-01T18:30:00Z", "espresso", "t")


def test_due_and_lifecycle(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    early = wakeup.add(conn, "2026-08-01T06:00:00Z", "deepdive", "a")
    late = wakeup.add(conn, "2026-08-01T09:00:00Z", "scan", "b")
    d = wakeup.due(conn, now="2026-08-01T07:00:00Z")
    assert [r["id"] for r in d] == [early]
    assert wakeup.record_attempt(conn, early) == 1
    assert wakeup.record_attempt(conn, early) == 2
    wakeup.mark(conn, early, "done")
    assert wakeup.due(conn, now="2026-08-01T07:00:00Z") == []
    assert [r["id"] for r in wakeup.list_open(conn)] == [late]
    row = conn.execute("SELECT * FROM wakeups WHERE id = ?", (early,)).fetchone()
    assert row["status"] == "done" and row["fired_at"] is not None


def test_cli_wakeup_add_and_list(tmp_path):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "sources.yaml").write_text("sources: []\n")
    (cfg / "settings.yaml").write_text("timezone: Asia/Dubai\ninbox_cap: 120\n")
    dbp = tmp_path / "j.db"
    runner = CliRunner()
    out = runner.invoke(main, [
        "wakeup", "add", "2026-08-01T14:30:00Z", "deepdive",
        "read FOMC statement, compare to stance",
        "--db", str(dbp), "--config-dir", str(cfg),
    ])
    assert out.exit_code == 0 and "scheduled wakeup" in out.output
    lst = runner.invoke(main, ["wakeup", "list", "--db", str(dbp), "--config-dir", str(cfg)])
    assert "2026-08-01T14:30:00Z" in lst.output and "deepdive" in lst.output
    bad = runner.invoke(main, [
        "wakeup", "add", "whenever", "deepdive", "t",
        "--db", str(dbp), "--config-dir", str(cfg),
    ])
    assert bad.exit_code != 0
