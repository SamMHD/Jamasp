from click.testing import CliRunner

from jamasp import db, dispatch, runner, wakeup
from jamasp.cli import main

SETTINGS = {
    "runs": {"claude_cmd": ["true"], "max_agent_runs_per_day": 20,
             "timeouts_seconds": {"brief": 900, "deepdive": 900, "scan": 300, "retro": 1200}},
    "telegram": {"bot_token_env": "JAMASP_TG_TOKEN", "chat_id_env": "JAMASP_TG_CHAT"},
}


def test_fires_due_marks_done(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    wid = wakeup.add(conn, "2026-08-01T06:00:00Z", "deepdive", "read minutes")
    calls = []
    monkeypatch.setattr(
        dispatch.runner, "run_agent",
        lambda c, s, rt, task=None, dry_run=False: calls.append((rt, task)) or "ok",
    )
    results = dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:00:00Z")
    assert results == [(wid, "ok")]
    assert calls == [("deepdive", "read minutes")]
    assert conn.execute("SELECT status FROM wakeups WHERE id=?", (wid,)).fetchone()["status"] == "done"


def test_failure_retries_next_tick_then_fails(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    wid = wakeup.add(conn, "2026-08-01T06:00:00Z", "deepdive", "t")
    sent = []
    monkeypatch.setattr(dispatch.runner, "run_agent",
                        lambda c, s, rt, task=None, dry_run=False: "failed")
    monkeypatch.setattr(dispatch.runner, "_notify_safe", lambda s, t: sent.append(t))
    # tick 1: attempt 1 -> stays pending
    assert dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:00:00Z") == [(wid, "failed")]
    row = conn.execute("SELECT * FROM wakeups WHERE id=?", (wid,)).fetchone()
    assert row["status"] == "pending" and row["attempts"] == 1
    # tick 2: attempt 2 -> marked failed + telegram
    dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:05:00Z")
    row = conn.execute("SELECT * FROM wakeups WHERE id=?", (wid,)).fetchone()
    assert row["status"] == "failed" and row["attempts"] == 2
    assert sent and "wakeup" in sent[-1].lower()


def test_deferred_stops_tick(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    w1 = wakeup.add(conn, "2026-08-01T06:00:00Z", "deepdive", "a")
    w2 = wakeup.add(conn, "2026-08-01T06:30:00Z", "deepdive", "b")
    monkeypatch.setattr(dispatch.runner, "run_agent",
                        lambda c, s, rt, task=None, dry_run=False: "deferred")
    results = dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:00:00Z")
    assert results == [(w1, "deferred")]  # w2 untouched this tick
    assert conn.execute("SELECT attempts FROM wakeups WHERE id=?", (w2,)).fetchone()["attempts"] == 0


def test_cli_dry_run_fires_nothing(tmp_path, monkeypatch):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "sources.yaml").write_text("sources: []\n")
    (cfg / "settings.yaml").write_text(
        "timezone: Asia/Dubai\ninbox_cap: 120\n"
        "runs:\n  claude_cmd: [\"true\"]\n  max_agent_runs_per_day: 20\n"
        "  timeouts_seconds: {brief: 900, deepdive: 900, scan: 300, retro: 1200}\n"
        "telegram:\n  bot_token_env: JAMASP_TG_TOKEN\n  chat_id_env: JAMASP_TG_CHAT\n"
    )
    dbp = tmp_path / "j.db"
    conn = db.connect(dbp)
    wakeup.add(conn, "2000-01-01T00:00:00Z", "deepdive", "ancient")
    out = CliRunner().invoke(main, ["dispatch", "--dry-run", "--db", str(dbp), "--config-dir", str(cfg)])
    assert out.exit_code == 0 and "deepdive" in out.output
    row = conn.execute("SELECT status, attempts FROM wakeups").fetchone()
    assert row["status"] == "pending" and row["attempts"] == 0
