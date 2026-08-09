"""systemd failure alerts — a unit dying is never silent.

Reached via `OnFailure=jamasp-alert@%n.service` on the units whose quiet
failure would cost something: the Access JWT sidecar, the origin lockdown and
its range refresh, certbot, and the panel.

This is the ops counterpart to `watchdog.py`. The watchdog answers "is the
analyst still producing?" once a day from data freshness; this answers "did a
unit just fail?" the moment systemd notices.
"""
from __future__ import annotations

import sqlite3
import subprocess
from datetime import datetime, timedelta

from jamasp.db import get_meta, set_meta, utcnow

# Telegram hard-rejects anything over 4096 characters. A noisy traceback must
# not turn a failure alert into a failed alert.
MAX_MESSAGE_CHARS = 3500
JOURNAL_LINES = 15

# jamasp-dispatch fires every 5 minutes; a persistent failure would otherwise
# send ~288 messages a day, and an alert channel that storms is one people
# mute. Suppression is per unit so a noisy unit cannot mask a quiet one.
ALERT_WINDOW_MINUTES = 60

_PROPERTIES = ("Description", "ActiveState", "SubState", "Result", "ExecMainStatus")


def _run(argv: list[str]) -> str:
    return subprocess.run(
        argv, capture_output=True, text=True, timeout=15
    ).stdout.strip()


def gather(unit: str, run=_run) -> dict[str, str]:
    """State and recent log lines for `unit`, best-effort.

    Never raises: this runs *because* something already failed, and an alert
    that crashes is worse than one missing a field.
    """
    info: dict[str, str] = {}

    try:
        argv = ["systemctl", "show"]
        for prop in _PROPERTIES:
            argv += ["-p", prop]
        argv += ["--value", unit]
        values = run(argv).splitlines()
        info.update(dict(zip(_PROPERTIES, [v.strip() for v in values])))
    except Exception:
        pass

    for prop in _PROPERTIES:
        info.setdefault(prop, "")

    try:
        journal = run(
            ["journalctl", "-u", unit, "-n", str(JOURNAL_LINES), "--no-pager"]
        )
    except Exception:
        journal = ""

    # journalctl does not return an empty string when it has nothing to show:
    # it prints the literal `-- No entries --` on stdout. That is also exactly
    # what a *permission* problem looks like from here — a caller outside the
    # systemd-journal group gets this marker rather than an error. Normalise
    # it to empty so compose() takes the explicit "cannot read" branch instead
    # of rendering the marker as though the unit had logged nothing.
    if journal.strip().lower() == "-- no entries --":
        journal = ""

    info["journal"] = journal
    return info


def compose(unit: str, info: dict[str, str]) -> str:
    """The Telegram message: Persian lead, English technical body.

    The body stays English deliberately — unit names, states and log lines
    are English strings, and translating the frame around them would make
    them harder to act on at 3am, not easier.
    """
    status = info.get("Result") or "unknown"
    exit_status = info.get("ExecMainStatus") or ""
    if exit_status and exit_status != "0":
        status = f"{status} (status {exit_status})"

    head = [
        f"⚠️ خطای سرویس — {unit}",
        "",
        "یک سرویس روی هاست جاماسپ با خطا متوقف شد.",
        "",
        f"unit:   {unit}",
        f"desc:   {info.get('Description', '')}",
        f"result: {status}",
        f"state:  {info.get('ActiveState', '')}/{info.get('SubState', '')}",
        "",
    ]

    journal = info.get("journal", "").strip()
    if journal:
        body = ["--- last log lines ---", journal]
    else:
        # Not the same as "it failed quietly". journalctl returns an empty
        # string rather than an error when the caller can't read the unit's
        # journal, so an unlabelled blank section reads as reassurance.
        body = [
            "--- no journal lines available ---",
            "(either the unit logged nothing, or this alert cannot read its",
            "journal — check that jamasp-alert@.service has",
            "SupplementaryGroups=systemd-journal)",
        ]

    msg = "\n".join(head + body)
    if len(msg) > MAX_MESSAGE_CHARS:
        keep = MAX_MESSAGE_CHARS - len("\n… truncated")
        msg = msg[:keep] + "\n… truncated"
    return msg


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def should_send(
    conn: sqlite3.Connection,
    unit: str,
    now: str | None = None,
    window_minutes: int = ALERT_WINDOW_MINUTES,
) -> bool:
    """True if `unit` has not already alerted inside the suppression window.

    Records the send time as a side effect when it returns True. Fails open:
    anything unparseable in the stored value means "send", because a missed
    alert costs more than a duplicate one.
    """
    now = now or utcnow()
    key = f"alert_last.{unit}"

    previous = get_meta(conn, key)
    if previous:
        try:
            if _parse(now) - _parse(previous) < timedelta(minutes=window_minutes):
                return False
        except Exception:
            pass  # unparseable stored value — fall through and send

    set_meta(conn, key, now)
    return True
