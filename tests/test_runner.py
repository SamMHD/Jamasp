import sys
from pathlib import Path

from jamasp import db, runner

FAKE = str(Path(__file__).parent / "fake_agent.py")


def settings_with(cmd_tail, cap=20, scan_timeout=300):
    return {
        "runs": {
            "claude_cmd": [sys.executable, FAKE] + cmd_tail,
            "max_agent_runs_per_day": cap,
            "timeouts_seconds": {"brief": 900, "deepdive": 900,
                                 "scan": scan_timeout, "retro": 1200},
        },
        "telegram": {"bot_token_env": "JAMASP_TG_TOKEN", "chat_id_env": "JAMASP_TG_CHAT"},
    }


def test_ok_run_recorded(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["ok"]), "scan")
    assert status == "ok"
    rows = conn.execute("SELECT * FROM agent_runs").fetchall()
    assert len(rows) == 1
    assert rows[0]["run_type"] == "scan" and rows[0]["status"] == "ok"
    assert rows[0]["exit_code"] == 0 and rows[0]["finished_at"] is not None


def test_retry_recovers_flaky(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    marker = tmp_path / "marker"
    status = runner.run_agent(
        conn, settings_with(["flaky", str(marker)]), "deepdive", task="read X"
    )
    assert status == "ok"


def test_persistent_failure_notifies(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(runner, "_notify_safe", lambda s, t: sent.append(t))
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["fail"]), "scan")
    assert status == "failed"
    assert sent and "scan" in sent[0]
    row = conn.execute("SELECT status FROM agent_runs ORDER BY id DESC").fetchone()
    assert row["status"] == "failed"


def test_timeout_status(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_notify_safe", lambda s, t: None)
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["sleep"], scan_timeout=1), "scan")
    assert status == "timeout"


def test_cap_defers_and_warns(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(runner, "_notify_safe", lambda s, t: sent.append(t))
    conn = db.connect(tmp_path / "j.db")
    s = settings_with(["ok"], cap=1)
    assert runner.run_agent(conn, s, "scan") == "ok"
    assert runner.run_agent(conn, s, "scan") == "deferred"
    assert sent and "cap" in sent[-1].lower()
    statuses = [r["status"] for r in conn.execute("SELECT status FROM agent_runs")]
    assert statuses == ["ok", "deferred"]
    # deferred rows don't consume the cap themselves
    assert runner.runs_today(conn) == 1


def test_notify_safe_swallows(monkeypatch):
    # no telegram env vars set -> notify.notify raises; _notify_safe must not
    runner._notify_safe({"telegram": {"bot_token_env": "X_NOPE", "chat_id_env": "Y_NOPE"}}, "t")


def test_dry_run_executes_and_records_nothing(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: calls.append((a, k)))
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["ok"]), "scan", dry_run=True)
    assert status == "ok"
    assert calls == []  # no subprocess was launched
    rows = conn.execute("SELECT * FROM agent_runs").fetchall()
    assert rows == []
