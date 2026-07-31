"""Dispatcher: fire due wakeup-queue entries through the runner."""
from __future__ import annotations

import sqlite3
from datetime import datetime

from jamasp import db, runner, wakeup

MAX_ATTEMPTS = 2
CAP_WARNED_META_KEY = "cap_warned_date"


def _today_dubai() -> str:
    """Today's date in Dubai, computed the same way runner.runs_today does.

    Deliberately wall-clock (runner.utcnow()), not the `now` a caller may
    pass to run_due for wakeup-due-time testing — cap accounting is always
    real-time, matching runs_today's own (pre-existing) wall-clock read.
    """
    now_dt = datetime.fromisoformat(runner.utcnow().replace("Z", "+00:00"))
    return now_dt.astimezone(runner.DUBAI).strftime("%Y-%m-%d")


def _warn_cap_once(conn: sqlite3.Connection, settings: dict, cap: int) -> None:
    """Send the cap-reached Telegram warning at most once per Dubai day."""
    today = _today_dubai()
    if db.get_meta(conn, CAP_WARNED_META_KEY) == today:
        return
    db.set_meta(conn, CAP_WARNED_META_KEY, today)
    runner._notify_safe(
        settings,
        f"Jamasp: daily run cap ({cap}) reached — dispatcher holding all wakeups"
        " until tomorrow.",
    )


def run_due(
    conn: sqlite3.Connection,
    settings: dict,
    now: str | None = None,
    dry_run: bool = False,
) -> list[tuple[int, str]]:
    results: list[tuple[int, str]] = []
    if not dry_run:
        cap = settings["runs"]["max_agent_runs_per_day"]
        if runner.runs_today(conn) >= cap:
            # Cap already hit: don't touch any wakeup's attempts and don't
            # invoke the runner — that would inflate attempts on every 5-min
            # tick (defeating the 2-attempt retry) and re-trigger the
            # runner's own cap notice on every tick. Warn once per day instead.
            _warn_cap_once(conn, settings, cap)
            return results
    for w in wakeup.due(conn, now=now):
        if dry_run:
            results.append((w["id"], "would-fire"))
            continue
        attempts = wakeup.record_attempt(conn, w["id"])
        status = runner.run_agent(
            conn, settings, w["run_type"], task=w["task"], notify_on_failure=False
        )
        results.append((w["id"], status))
        if status == "ok":
            wakeup.mark(conn, w["id"], "done")
        elif status == "deferred":
            # Fallback only: the cap was hit mid-loop, after our pre-check
            # passed (a race with a concurrent run). Later wakeups this tick
            # would defer too; the next tick's pre-check takes over.
            break
        elif attempts >= MAX_ATTEMPTS:
            wakeup.mark(conn, w["id"], "failed")
            runner._notify_safe(
                settings,
                f"Jamasp FAILURE: wakeup #{w['id']} ({w['run_type']}: {w['task']})"
                f" gave up after {attempts} attempts.",
            )
        # else: leave pending; the next 5-minute tick retries it
    return results
