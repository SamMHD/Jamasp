from pathlib import Path

from jamasp import db, watchdog, wakeup

NOW = "2026-08-01T06:00:00Z"  # 2026-08-01 10:00 Dubai


def healthy(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    db.set_meta(conn, "last_ingest_at", "2026-08-01T05:30:00Z")
    reports = tmp_path / "reports"
    (reports / "2026" / "07").mkdir(parents=True)
    (reports / "2026" / "07" / "2026-07-31-brief.md").write_text("# brief")
    return conn, reports


def test_healthy_no_violations(tmp_path):
    conn, reports = healthy(tmp_path)
    assert watchdog.check(conn, reports, now=NOW) == []


def test_stale_ingest(tmp_path):
    conn, reports = healthy(tmp_path)
    db.set_meta(conn, "last_ingest_at", "2026-08-01T04:00:00Z")  # 2h old
    v = watchdog.check(conn, reports, now=NOW)
    assert any("ingest" in x for x in v)


def test_missing_ingest_meta(tmp_path):
    conn, reports = healthy(tmp_path)
    conn.execute("DELETE FROM meta")
    conn.commit()
    assert any("ingest" in x for x in watchdog.check(conn, reports, now=NOW))


def test_missing_yesterday_brief(tmp_path):
    conn, reports = healthy(tmp_path)
    (reports / "2026" / "07" / "2026-07-31-brief.md").unlink()
    v = watchdog.check(conn, reports, now=NOW)
    assert any("brief" in x for x in v)


def test_stuck_wakeup(tmp_path):
    conn, reports = healthy(tmp_path)
    wakeup.add(conn, "2026-08-01T05:00:00Z", "deepdive", "t")  # 60 min overdue
    v = watchdog.check(conn, reports, now=NOW)
    assert any("wakeup" in x for x in v)


def test_run_sends_single_telegram_on_violation(tmp_path, monkeypatch):
    conn, reports = healthy(tmp_path)
    db.set_meta(conn, "last_ingest_at", "2026-08-01T04:00:00Z")
    sent = []
    monkeypatch.setattr(watchdog.runner, "_notify_safe", lambda s, t: sent.append(t))
    v = watchdog.run(conn, {}, reports, now=NOW)
    assert v and len(sent) == 1 and "Jamasp watchdog" in sent[0]
