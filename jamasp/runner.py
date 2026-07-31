"""Wrapped `claude -p` execution: safety cap, timeout, one retry, telegram notice.

Every agent run — fixed timers and dispatched wakeups alike — goes through
run_agent(), so cap accounting and failure notices live in exactly one place.
"""
from __future__ import annotations

import os
import signal
import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone

from jamasp import notify as notify_mod
from jamasp.db import utcnow

DUBAI = timezone(timedelta(hours=4))


def _notify_safe(settings: dict, text: str) -> None:
    try:
        notify_mod.notify(text, settings)
    except Exception:
        pass  # infra never dies on a Telegram hiccup


def runs_today(conn: sqlite3.Connection, now: str | None = None) -> int:
    now_dt = datetime.fromisoformat((now or utcnow()).replace("Z", "+00:00"))
    today_dubai = now_dt.astimezone(DUBAI).strftime("%Y-%m-%d")
    n = 0
    for r in conn.execute(
        "SELECT started_at FROM agent_runs WHERE status != 'deferred'"
    ):
        started = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
        if started.astimezone(DUBAI).strftime("%Y-%m-%d") == today_dubai:
            n += 1
    return n


def _record(conn, run_type, task, started_at, exit_code, status) -> None:
    conn.execute(
        "INSERT INTO agent_runs (run_type, task, started_at, finished_at, exit_code, status)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (run_type, task, started_at, utcnow(), exit_code, status),
    )
    conn.commit()


def _execute_once(cmd: list[str], timeout: int) -> tuple[int | None, str]:
    """Run once; return (exit_code, status) where status is ok|failed|timeout.

    Uses Popen + a new process group so a timeout can be enforced by killing
    the whole group (SIGKILL) rather than subprocess.run's timeout path,
    which only kills the direct child and then blocks in communicate()
    until grandchildren (claude's own tool subprocesses) close the pipes
    they inherited — i.e. it can hang forever. Output was always discarded,
    so we route both streams to DEVNULL instead of capturing.
    """
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        return None, "failed"
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        return None, "timeout"
    return proc.returncode, "ok" if proc.returncode == 0 else "failed"


def run_agent(
    conn: sqlite3.Connection,
    settings: dict,
    run_type: str,
    task: str | None = None,
    dry_run: bool = False,
    notify_on_failure: bool = True,
) -> str:
    cfg = settings["runs"]
    prompt = f"/{run_type} {task}" if task else f"/{run_type}"
    cmd = list(cfg["claude_cmd"]) + [prompt]
    if dry_run:
        return "ok"
    started_at = utcnow()
    cap = cfg["max_agent_runs_per_day"]
    if runs_today(conn) >= cap:
        _record(conn, run_type, task, started_at, None, "deferred")
        _notify_safe(
            settings,
            f"Jamasp: daily run cap ({cap}) reached — deferred {run_type} run."
            + (f" Task: {task}" if task else ""),
        )
        return "deferred"
    timeout = cfg["timeouts_seconds"][run_type]
    exit_code, status = _execute_once(cmd, timeout)
    if status != "ok":  # one retry, immediately
        exit_code, status = _execute_once(cmd, timeout)
    _record(conn, run_type, task, started_at, exit_code, status)
    if status != "ok" and notify_on_failure:
        _notify_safe(
            settings,
            f"Jamasp FAILURE: {run_type} run {status} after retry"
            + (f" (task: {task})" if task else "")
            + f", exit={exit_code}.",
        )
    return status
