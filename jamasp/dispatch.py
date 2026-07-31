"""Dispatcher: fire due wakeup-queue entries through the runner."""
from __future__ import annotations

import sqlite3

from jamasp import runner, wakeup

MAX_ATTEMPTS = 2


def run_due(
    conn: sqlite3.Connection,
    settings: dict,
    now: str | None = None,
    dry_run: bool = False,
) -> list[tuple[int, str]]:
    results: list[tuple[int, str]] = []
    for w in wakeup.due(conn, now=now):
        if dry_run:
            results.append((w["id"], "would-fire"))
            continue
        attempts = wakeup.record_attempt(conn, w["id"])
        status = runner.run_agent(conn, settings, w["run_type"], task=w["task"])
        results.append((w["id"], status))
        if status == "ok":
            wakeup.mark(conn, w["id"], "done")
        elif status == "deferred":
            break  # daily cap hit — later wakeups would defer too; next tick retries
        elif attempts >= MAX_ATTEMPTS:
            wakeup.mark(conn, w["id"], "failed")
            runner._notify_safe(
                settings,
                f"Jamasp FAILURE: wakeup #{w['id']} ({w['run_type']}: {w['task']})"
                f" gave up after {attempts} attempts.",
            )
        # else: leave pending; the next 5-minute tick retries it
    return results
