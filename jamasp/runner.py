"""Wrapped `claude -p` execution: safety cap, timeout, one retry, telegram notice.

Every agent run — fixed timers and dispatched wakeups alike — goes through
run_agent(), so cap accounting and failure notices live in exactly one place.
"""
from __future__ import annotations

import os
import signal
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

from jamasp import notify as notify_mod
from jamasp.db import utcnow

DUBAI = timezone(timedelta(hours=4))

# How much of a failed run's output to keep. Enough for a stack trace's last
# frame or an auth error, small enough that a Telegram message (hard limit
# 4096 chars) still fits with the frame around it.
OUTPUT_TAIL_CHARS = 500


def _notify_safe(conn: sqlite3.Connection, settings: dict, text: str) -> None:
    try:
        notify_mod.notify(text, settings)
        ok = True
    except Exception:
        ok = False  # infra never dies on a Telegram hiccup
    try:
        notify_mod.log_sent(conn, text, ok)
    except Exception:
        pass


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


def _git_head() -> str | None:
    """Current HEAD commit, or None if this isn't a usable git checkout.

    None means "can't tell" — callers must not read it as "nothing changed".
    """
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None


def _tail(path: str) -> str:
    """Last OUTPUT_TAIL_CHARS of a file, or "" if it can't be read."""
    try:
        with open(path, "r", errors="replace") as fh:
            try:
                fh.seek(max(0, os.path.getsize(path) - OUTPUT_TAIL_CHARS))
            except OSError:
                pass
            return fh.read()[-OUTPUT_TAIL_CHARS:].strip()
    except OSError:
        return ""


def _execute_once(cmd: list[str], timeout: int) -> tuple[int | None, str, str]:
    """Run once; return (exit_code, status, tail) — status is ok|failed|timeout.

    Uses Popen + a new process group so a timeout can be enforced by killing
    the whole group (SIGKILL) rather than subprocess.run's timeout path,
    which only kills the direct child and then blocks in communicate()
    until grandchildren (claude's own tool subprocesses) close the pipes
    they inherited — i.e. it can hang forever.

    Both streams go to a temporary **file**, never a pipe: a file has no
    buffer to fill and no reader to block on, so a grandchild holding the
    inherited handle open cannot wedge us the way the pipe path could. `tail`
    is the last chunk of that file on a failure and "" on success — an
    `exit=1` with no reason cost 3.5 dark days on 2026-08-28 (docs/todo/007).
    """
    with tempfile.TemporaryDirectory(prefix="jamasp-run-") as tmp:
        out_path = os.path.join(tmp, "output")
        try:
            out = open(out_path, "wb")
        except OSError:
            return None, "failed", ""
        try:
            try:
                proc = subprocess.Popen(
                    cmd, stdout=out, stderr=subprocess.STDOUT, start_new_session=True
                )
            except OSError as exc:
                return None, "failed", str(exc)
        finally:
            out.close()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            return None, "timeout", _tail(out_path)
        if proc.returncode == 0:
            return proc.returncode, "ok", ""
        return proc.returncode, "failed", _tail(out_path)


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
            conn,
            settings,
            f"Jamasp: daily run cap ({cap}) reached — deferred {run_type} run."
            + (f" Task: {task}" if task else ""),
        )
        return "deferred"
    timeout = cfg["timeouts_seconds"][run_type]
    head_before = _git_head()
    exit_code, status, tail = _execute_once(cmd, timeout)
    if status != "ok":  # one retry, immediately
        exit_code, status, tail = _execute_once(cmd, timeout)
    # Every run commits (CLAUDE.md rule 4), so exit 0 with HEAD untouched
    # means the run did nothing — the failure mode that made the 12 Aug CPI
    # deepdive invisible. Deliberately not retried: an empty run may still
    # have posted to Telegram, and a blind re-run risks a double post.
    if status == "ok" and head_before is not None and _git_head() == head_before:
        status = "empty"
    _record(conn, run_type, task, started_at, exit_code, status)
    if status != "ok" and notify_on_failure:
        if status == "empty":
            text = (
                f"Jamasp EMPTY RUN: {run_type} exited 0 but committed nothing"
                + (f" (task: {task})" if task else "")
                + " — inputs missing, or it gave up silently. Not retried."
            )
        else:
            text = (
                f"Jamasp FAILURE: {run_type} run {status} after retry"
                + (f" (task: {task})" if task else "")
                + f", exit={exit_code}."
                + (f"\n--- last output ---\n{tail}" if tail else "")
            )
        # journalctl alone must be enough next time: through the whole
        # 2026-08-28 outage the unit's log carried only "scan: failed".
        if tail:
            print(f"{run_type}: {status} — last output:\n{tail}", file=sys.stderr)
        _notify_safe(conn, settings, text)
    return status
