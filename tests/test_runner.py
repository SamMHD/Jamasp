import itertools
import os
import sys
import time
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


def _committing(monkeypatch):
    """Simulate a run that does its job: HEAD moves while it runs.

    Without this the fake agent commits nothing, so run_agent correctly
    reports `empty` — see test_exit_zero_without_a_commit_is_empty.
    """
    counter = itertools.count()
    monkeypatch.setattr(runner, "_git_head", lambda: f"head{next(counter)}")


def test_ok_run_recorded(tmp_path, monkeypatch):
    _committing(monkeypatch)
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["ok"]), "scan")
    assert status == "ok"
    rows = conn.execute("SELECT * FROM agent_runs").fetchall()
    assert len(rows) == 1
    assert rows[0]["run_type"] == "scan" and rows[0]["status"] == "ok"
    assert rows[0]["exit_code"] == 0 and rows[0]["finished_at"] is not None


def test_retry_recovers_flaky(tmp_path, monkeypatch):
    _committing(monkeypatch)
    conn = db.connect(tmp_path / "j.db")
    marker = tmp_path / "marker"
    status = runner.run_agent(
        conn, settings_with(["flaky", str(marker)]), "deepdive", task="read X"
    )
    assert status == "ok"


def test_persistent_failure_notifies(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: sent.append(t))
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["fail"]), "scan")
    assert status == "failed"
    assert sent and "scan" in sent[0]
    row = conn.execute("SELECT status FROM agent_runs ORDER BY id DESC").fetchone()
    assert row["status"] == "failed"


def test_timeout_status(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: None)
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["sleep"], scan_timeout=1), "scan")
    assert status == "timeout"


def test_cap_defers_and_warns(tmp_path, monkeypatch):
    _committing(monkeypatch)
    sent = []
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: sent.append(t))
    conn = db.connect(tmp_path / "j.db")
    s = settings_with(["ok"], cap=1)
    assert runner.run_agent(conn, s, "scan") == "ok"
    assert runner.run_agent(conn, s, "scan") == "deferred"
    assert sent and "cap" in sent[-1].lower()
    statuses = [r["status"] for r in conn.execute("SELECT status FROM agent_runs")]
    assert statuses == ["ok", "deferred"]
    # deferred rows don't consume the cap themselves
    assert runner.runs_today(conn) == 1


def test_timeout_kills_grandchild_process_group(tmp_path, monkeypatch):
    # The fake agent spawns its own long-sleeping child and records its pid.
    # A correct timeout kills the whole process group, so the grandchild
    # must be gone almost immediately after run_agent returns — not lingering
    # for the 30s it would otherwise sleep.
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: None)
    conn = db.connect(tmp_path / "j.db")
    marker = tmp_path / "child_pid"
    status = runner.run_agent(
        conn, settings_with(["spawn_orphan", str(marker)], scan_timeout=1), "scan"
    )
    assert status == "timeout"
    child_pid = int(marker.read_text().strip())
    # Give the OS a brief moment to reap; the process must not still be alive.
    deadline = time.monotonic() + 2
    alive = True
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            alive = False
            break
        time.sleep(0.05)
    assert not alive, "grandchild process survived the timeout kill"


def test_notify_safe_swallows(tmp_path, monkeypatch):
    # no telegram env vars set -> notify.notify raises; _notify_safe must not
    conn = db.connect(tmp_path / "j.db")
    runner._notify_safe(conn, {"telegram": {"bot_token_env": "X_NOPE", "chat_id_env": "Y_NOPE"}}, "t")


def test_dry_run_executes_and_records_nothing(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(runner.subprocess, "run", lambda *a, **k: calls.append((a, k)))
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["ok"]), "scan", dry_run=True)
    assert status == "ok"
    assert calls == []  # no subprocess was launched
    rows = conn.execute("SELECT * FROM agent_runs").fetchall()
    assert rows == []


def test_exit_zero_without_a_commit_is_empty(tmp_path, monkeypatch):
    # The 12 Aug CPI deepdive ran, found its inputs missing, exited 0 and
    # committed nothing — recorded "ok", so nothing alerted and the desk
    # got its read ~3h late. An exit-0 run that left HEAD untouched did
    # not do its job.
    sent = []
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: sent.append(t))
    monkeypatch.setattr(runner, "_git_head", lambda: "abc1234")
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["ok"]), "deepdive", task="read CPI")
    assert status == "empty"
    row = conn.execute("SELECT * FROM agent_runs ORDER BY id DESC").fetchone()
    assert row["status"] == "empty" and row["exit_code"] == 0
    assert sent and "deepdive" in sent[0]
    assert "read CPI" in sent[0]


def test_exit_zero_with_a_commit_is_ok(tmp_path, monkeypatch):
    heads = iter(["before01", "after002"])
    sent = []
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: sent.append(t))
    monkeypatch.setattr(runner, "_git_head", lambda: next(heads))
    conn = db.connect(tmp_path / "j.db")
    assert runner.run_agent(conn, settings_with(["ok"]), "brief") == "ok"
    assert sent == []


def test_empty_run_is_not_retried(tmp_path, monkeypatch):
    # A run that committed nothing may still have posted to Telegram; a blind
    # re-run risks a double post. Record it, alert, don't repeat it.
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: None)
    monkeypatch.setattr(runner, "_git_head", lambda: "abc1234")
    calls = []
    real = runner._execute_once

    def counting(cmd, timeout):
        calls.append(cmd)
        return real(cmd, timeout)

    monkeypatch.setattr(runner, "_execute_once", counting)
    conn = db.connect(tmp_path / "j.db")
    assert runner.run_agent(conn, settings_with(["ok"]), "scan") == "empty"
    assert len(calls) == 1


def test_unknown_head_does_not_flag_empty(tmp_path, monkeypatch):
    # Not a git checkout (or git unavailable): we can't tell whether the run
    # committed, so don't cry wolf.
    sent = []
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: sent.append(t))
    monkeypatch.setattr(runner, "_git_head", lambda: None)
    conn = db.connect(tmp_path / "j.db")
    assert runner.run_agent(conn, settings_with(["ok"]), "scan") == "ok"
    assert sent == []


def test_failed_run_keeps_failed_status(tmp_path, monkeypatch):
    # An empty check must not mask a real failure: HEAD is unchanged after a
    # failing run too, and "failed" is the more informative status.
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: None)
    monkeypatch.setattr(runner, "_git_head", lambda: "abc1234")
    conn = db.connect(tmp_path / "j.db")
    assert runner.run_agent(conn, settings_with(["fail"]), "scan") == "failed"


def test_git_head_returns_none_outside_a_repo(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert runner._git_head() is None


def test_failure_notice_carries_the_reason(tmp_path, monkeypatch):
    # 2026-08-28..31: the OAuth refresh token lapsed and every agent run
    # failed with a bare `exit=1`. The cause was one line on claude's stderr
    # and _execute_once threw it away (docs/todo/007).
    sent = []
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: sent.append(t))
    conn = db.connect(tmp_path / "j.db")
    assert runner.run_agent(conn, settings_with(["fail"]), "scan") == "failed"
    assert sent and "boom" in sent[0], sent


def test_failure_reason_reaches_the_journal(tmp_path, monkeypatch, capsys):
    # journalctl alone must be enough next time: the unit's own log carried
    # only "scan: failed" through the whole 3.5-day outage.
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: None)
    conn = db.connect(tmp_path / "j.db")
    runner.run_agent(conn, settings_with(["fail"]), "scan")
    assert "boom" in capsys.readouterr().err


def test_successful_run_captures_no_output(tmp_path, monkeypatch):
    # Success is not interesting and must not carry the child's chatter into
    # a notice or the journal.
    code, status, tail = runner._execute_once(
        settings_with(["ok"])["runs"]["claude_cmd"] + ["/scan"], 30
    )
    assert (code, status) == (0, "ok")
    assert tail == ""


def test_failed_run_tail_is_bounded(tmp_path, monkeypatch):
    # A crash can dump megabytes; a Telegram message hard-fails over 4096.
    code, status, tail = runner._execute_once(
        settings_with(["flood"])["runs"]["claude_cmd"] + ["/scan"], 30
    )
    assert status == "failed"
    assert 0 < len(tail) <= runner.OUTPUT_TAIL_CHARS
    # the tail is the END of the stream, where the error message lives
    assert tail.rstrip().endswith("LAST-LINE-MARKER")


def test_timeout_with_output_file_does_not_hang(tmp_path, monkeypatch):
    # The DEVNULL this replaced was deliberate: a grandchild inheriting the
    # output handle can hold a *pipe* open forever. A file has no reader to
    # block on, so the timeout path must still return promptly.
    monkeypatch.setattr(runner, "_notify_safe", lambda c, s, t: None)
    conn = db.connect(tmp_path / "j.db")
    marker = tmp_path / "child_pid2"
    start = time.monotonic()
    status = runner.run_agent(
        conn, settings_with(["spawn_orphan", str(marker)], scan_timeout=1), "scan"
    )
    elapsed = time.monotonic() - start
    assert status == "timeout"
    # two attempts x 1s timeout, plus slack — nowhere near the 30s the
    # grandchild sleeps for.
    assert elapsed < 15, f"timeout path took {elapsed:.1f}s — it is blocking on the child's output"
