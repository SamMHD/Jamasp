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
        lambda c, s, rt, task=None, dry_run=False, notify_on_failure=True: calls.append((rt, task)) or "ok",
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
                        lambda c, s, rt, task=None, dry_run=False, notify_on_failure=True: "failed")
    monkeypatch.setattr(dispatch.runner, "_notify_safe", lambda c, s, t: sent.append(t))
    # tick 1: attempt 1 -> stays pending
    assert dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:00:00Z") == [(wid, "failed")]
    row = conn.execute("SELECT * FROM wakeups WHERE id=?", (wid,)).fetchone()
    assert row["status"] == "pending" and row["attempts"] == 1
    # tick 2: attempt 2 -> marked failed + telegram
    dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:05:00Z")
    row = conn.execute("SELECT * FROM wakeups WHERE id=?", (wid,)).fetchone()
    assert row["status"] == "failed" and row["attempts"] == 2
    # exactly one notice total across both ticks (the dispatcher's give-up
    # notice); run_agent's own per-invocation failure notice is suppressed
    # via notify_on_failure=False, so no duplicate Telegram noise.
    assert len(sent) == 1
    assert "wakeup" in sent[-1].lower() and "2 attempt" in sent[-1].lower()


def test_dispatch_suppresses_runner_own_failure_notice(tmp_path, monkeypatch):
    # dispatch is responsible for its own give-up notice; run_agent's
    # per-invocation failure notice must be suppressed to avoid duplicates.
    conn = db.connect(tmp_path / "j.db")
    wakeup.add(conn, "2026-08-01T06:00:00Z", "deepdive", "t")
    kwargs_seen = []
    monkeypatch.setattr(
        dispatch.runner, "run_agent",
        lambda c, s, rt, task=None, dry_run=False, notify_on_failure=True:
            kwargs_seen.append(notify_on_failure) or "failed",
    )
    monkeypatch.setattr(dispatch.runner, "_notify_safe", lambda c, s, t: None)
    dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:00:00Z")
    assert kwargs_seen == [False]


def test_deferred_stops_tick(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    w1 = wakeup.add(conn, "2026-08-01T06:00:00Z", "deepdive", "a")
    w2 = wakeup.add(conn, "2026-08-01T06:30:00Z", "deepdive", "b")
    monkeypatch.setattr(dispatch.runner, "run_agent",
                        lambda c, s, rt, task=None, dry_run=False, notify_on_failure=True: "deferred")
    results = dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:00:00Z")
    assert results == [(w1, "deferred")]  # w2 untouched this tick
    assert conn.execute("SELECT attempts FROM wakeups WHERE id=?", (w2,)).fetchone()["attempts"] == 0


def _settings(cap):
    return {
        "runs": {"claude_cmd": ["true"], "max_agent_runs_per_day": cap,
                 "timeouts_seconds": {"brief": 900, "deepdive": 900, "scan": 300, "retro": 1200}},
        "telegram": {"bot_token_env": "JAMASP_TG_TOKEN", "chat_id_env": "JAMASP_TG_CHAT"},
    }


def _seed_agent_run(conn, started_at):
    conn.execute(
        "INSERT INTO agent_runs (run_type, task, started_at, finished_at, exit_code, status)"
        " VALUES ('scan', NULL, ?, ?, 0, 'ok')",
        (started_at, started_at),
    )
    conn.commit()


def test_cap_reached_precheck_skips_without_touching_wakeups(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    _seed_agent_run(conn, db.utcnow())  # one run "today" (wall-clock) hits cap=1
    wid = wakeup.add(conn, "2000-01-01T00:00:00Z", "deepdive", "t")
    called = []
    monkeypatch.setattr(dispatch.runner, "run_agent", lambda *a, **k: called.append(1) or "ok")
    monkeypatch.setattr(dispatch.runner, "_notify_safe", lambda c, s, t: None)
    results = dispatch.run_due(conn, _settings(cap=1))
    assert results == []
    assert called == []  # run_agent never invoked
    row = conn.execute("SELECT * FROM wakeups WHERE id=?", (wid,)).fetchone()
    assert row["attempts"] == 0 and row["status"] == "pending"


def test_cap_warning_throttled_across_ticks_then_rewarns_next_day(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    day1, day2 = "2026-08-01T10:00:00Z", "2026-08-02T10:00:00Z"
    _seed_agent_run(conn, day1)
    _seed_agent_run(conn, day2)
    settings = _settings(cap=1)
    sent, called = [], []
    monkeypatch.setattr(dispatch.runner, "_notify_safe", lambda c, s, t: sent.append(t))
    monkeypatch.setattr(dispatch.runner, "run_agent", lambda *a, **k: called.append(1) or "ok")

    monkeypatch.setattr(dispatch.runner, "utcnow", lambda: day1)
    assert dispatch.run_due(conn, settings) == []
    assert dispatch.run_due(conn, settings) == []  # second tick, same Dubai day
    assert called == []
    assert len(sent) == 1  # throttled: only the first tick warned

    monkeypatch.setattr(dispatch.runner, "utcnow", lambda: day2)
    assert dispatch.run_due(conn, settings) == []
    assert len(sent) == 2  # a new day re-warns


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
