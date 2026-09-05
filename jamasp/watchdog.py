"""No-LLM health checks; Jamasp being down is never silent."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jamasp import runner
from jamasp.db import get_meta, utcnow

DUBAI = timezone(timedelta(hours=4))
INGEST_STALE_MINUTES = 60
WAKEUP_STUCK_MINUTES = 30

# Warn this many days before the OAuth refresh token lapses.
#
# On 2026-08-28 that token expired and every Claude-dependent path — brief,
# scan, retro, deepdive, the lede digest and the flash triage — went dark for
# 3.5 days. The box invokes `claude` every two hours and that did NOT extend
# the token, so use is no signal; the timestamp in the credentials file is the
# only warning available. Three days is enough slack for a weekend.
CREDENTIALS_WARN_DAYS = 3

DEFAULT_CREDENTIALS_PATH = Path.home() / ".claude" / ".credentials.json"

# The weights pipeline — bars -> signal states -> ridge fits — is refreshed
# once a day by jamasp-weights.service. Until 2026-09-05 nothing here watched
# it: the unit failed loudly every night for 12 days, and the moment
# `bars backfill` was made non-fatal (so a dead hourly endpoint stops costing
# the daily pull and the two steps behind it) that nightly alert was the ONLY
# thing standing between a half-dead pipeline and silence. These checks are
# what replaces it.
#
# Two clocks, so two thresholds. Bars and signal states follow the MARKET
# calendar: gold futures do not print at the weekend, so on a Monday morning
# the newest daily bar is Friday's and the newest bars-sourced state is
# stamped Saturday 00:00Z — legitimately ~3 days old. Four days clears that
# worst legitimate gap by a day while still surfacing a stalled refresh
# within one further run.
BARS_STALE_DAYS = 4
SIGNAL_STATE_STALE_DAYS = 4

# A fit's timestamp is wall-clock, not market time — the refit runs nightly
# whether or not the market moved. Three days is three consecutive missed
# refits: enough that one transient failure does not page the desk, few
# enough that the maps are never a week deep into unrefreshed multipliers.
WEIGHT_FIT_STALE_DAYS = 3

# What to do about it, appended to every weights-pipeline violation — same
# reasoning as _REAUTH below.
_WEIGHTS = "check jamasp-weights.service"

# What to do about it, appended to every credentials violation. An alert that
# names the fix ends the incident; one that does not costs days (docs/todo/007).
_REAUTH = "run `claude` as the service user to re-authenticate"


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _epoch_to_dt(value: float) -> datetime:
    """Accept either seconds or milliseconds since the epoch.

    Claude writes milliseconds today. Reading a seconds value as milliseconds
    would place it in 1970 and report a permanently expired credential — a
    false alarm that would train the desk to ignore this check.
    """
    seconds = value / 1000 if value > 1e11 else value
    return datetime.fromtimestamp(seconds, tz=timezone.utc)


def _credentials_violation(path: Path, now_dt: datetime) -> str | None:
    """One violation string, or None when the refresh token is comfortably live.

    Deliberately loud about every unreadable case rather than only about a
    near expiry: "cannot verify" is not the same as "fine", and silence here
    is exactly what this module exists to prevent.

    Known limitation: a host authenticating by `ANTHROPIC_API_KEY` instead of
    an OAuth login has no credentials file and would be reported as missing.
    The deployed host uses the OAuth login (see the deploy skill), so that
    trade is worth it; revisit if a key-authenticated host is ever added.
    """
    if not path.exists():
        return f"Claude credentials file missing ({path}) — no agent run can succeed; {_REAUTH}"
    try:
        oauth = json.loads(path.read_text())["claudeAiOauth"]
        raw = oauth["refreshTokenExpiresAt"]
        expires = _epoch_to_dt(float(raw))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return (f"Claude credentials unreadable ({path}): {type(exc).__name__}"
                f" — cannot verify the login; {_REAUTH}")

    left = expires - now_dt
    if left <= timedelta(0):
        return (f"Claude OAuth refresh token EXPIRED {expires:%Y-%m-%d %H:%M}Z"
                f" — every agent run is failing; {_REAUTH}")
    if left <= timedelta(days=CREDENTIALS_WARN_DAYS):
        hours = int(left.total_seconds() // 3600)
        return (f"Claude OAuth refresh token expires {expires:%Y-%m-%d %H:%M}Z"
                f" (in {hours}h) — {_REAUTH} before it lapses")
    return None


def _freshness_violation(
    label: str, newest: str | None, now_dt: datetime, max_days: int, never: str
) -> str | None:
    """One violation string, or None when `newest` is comfortably recent.

    An EMPTY table is a violation, not a pass. `MAX(ts)` over no rows is NULL,
    and a naive comparison against NULL reads as "not stale" — reporting a
    pipeline that has never run once as healthy. That is precisely the state
    this check was written to catch: on 2026-09-05 `bars` and `weight_fits`
    had been empty since the day the learning loop shipped.
    """
    if newest is None:
        return f"{never}; {_WEIGHTS}"
    age = now_dt - _parse(newest)
    if age > timedelta(days=max_days):
        return (f"{label} stale: newest {newest} ({age.days}d old,"
                f" > {max_days}d); {_WEIGHTS}")
    return None


def check(
    conn: sqlite3.Connection,
    reports_dir: Path,
    now: str | None = None,
    credentials_path: Path | None = None,
) -> list[str]:
    now_dt = _parse(now or utcnow())
    violations: list[str] = []

    creds = _credentials_violation(
        Path(credentials_path) if credentials_path else DEFAULT_CREDENTIALS_PATH,
        now_dt,
    )
    if creds:
        violations.append(creds)

    last_ingest = get_meta(conn, "last_ingest_at")
    if last_ingest is None:
        violations.append("ingest has never recorded a heartbeat (meta.last_ingest_at missing)")
    elif now_dt - _parse(last_ingest) > timedelta(minutes=INGEST_STALE_MINUTES):
        violations.append(f"ingest stale: last ran {last_ingest} (> {INGEST_STALE_MINUTES} min ago)")

    yesterday = (now_dt.astimezone(DUBAI) - timedelta(days=1)).strftime("%Y-%m-%d")
    y, m, _ = yesterday.split("-")
    brief = Path(reports_dir) / y / m / f"{yesterday}-brief.md"
    if not brief.exists():
        violations.append(f"yesterday's brief missing: {brief}")

    threshold = (now_dt - timedelta(minutes=WAKEUP_STUCK_MINUTES)).strftime("%Y-%m-%dT%H:%M:%SZ")
    stuck = conn.execute(
        "SELECT COUNT(*) FROM wakeups WHERE status = 'pending' AND due_at < ?",
        (threshold,),
    ).fetchone()[0]
    if stuck:
        violations.append(f"wakeup queue stuck: {stuck} pending entries overdue > {WAKEUP_STUCK_MINUTES} min")

    # The daily timeframe is the anchor: it is the cheapest pull and the one
    # every fit and map depends on, so its absence is unambiguous.
    for violation in (
        _freshness_violation(
            "bars",
            conn.execute(
                "SELECT MAX(ts) FROM bars WHERE timeframe = '1d'"
            ).fetchone()[0],
            now_dt, BARS_STALE_DAYS,
            "bars have never been backfilled (no 1d rows)",
        ),
        _freshness_violation(
            "signal states",
            conn.execute("SELECT MAX(ts) FROM signal_states").fetchone()[0],
            now_dt, SIGNAL_STATE_STALE_DAYS,
            "signal states have never been computed (table empty)",
        ),
        _freshness_violation(
            "weight fit",
            conn.execute("SELECT MAX(fitted_at) FROM weight_fits").fetchone()[0],
            now_dt, WEIGHT_FIT_STALE_DAYS,
            "weight fit has never landed (weight_fits empty)"
            " — the maps are running on unfitted priors",
        ),
    ):
        if violation:
            violations.append(violation)

    return violations


def run(
    conn: sqlite3.Connection,
    settings: dict,
    reports_dir: Path,
    now: str | None = None,
    credentials_path: Path | None = None,
) -> list[str]:
    violations = check(
        conn, reports_dir, now=now, credentials_path=credentials_path
    )
    if violations:
        runner._notify_safe(
            conn, settings, "Jamasp watchdog:\n" + "\n".join(f"- {v}" for v in violations)
        )
    return violations
