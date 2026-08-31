import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jamasp import db, watchdog, wakeup

NOW = "2026-08-01T06:00:00Z"  # 2026-08-01 10:00 Dubai


def _creds(tmp_path, *, refresh_in_days=30, body=None):
    """A credentials file shaped like Claude's, expiring in N days from NOW."""
    p = tmp_path / ".credentials.json"
    if body is not None:
        p.write_text(body)
        return p
    now = datetime.strptime(NOW, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    expires = now + timedelta(days=refresh_in_days)
    p.write_text(json.dumps({"claudeAiOauth": {
        "expiresAt": int(expires.timestamp() * 1000),
        "refreshTokenExpiresAt": int(expires.timestamp() * 1000),
        "subscriptionType": "max",
    }}))
    return p


def healthy(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    db.set_meta(conn, "last_ingest_at", "2026-08-01T05:30:00Z")
    reports = tmp_path / "reports"
    (reports / "2026" / "07").mkdir(parents=True)
    (reports / "2026" / "07" / "2026-07-31-brief.md").write_text("# brief")
    return conn, reports, _creds(tmp_path)


def _check(conn, reports, creds, now=NOW):
    return watchdog.check(conn, reports, now=now, credentials_path=creds)


def test_healthy_no_violations(tmp_path):
    conn, reports, creds = healthy(tmp_path)
    assert _check(conn, reports, creds) == []


def test_stale_ingest(tmp_path):
    conn, reports, creds = healthy(tmp_path)
    db.set_meta(conn, "last_ingest_at", "2026-08-01T04:00:00Z")  # 2h old
    assert any("ingest" in x for x in _check(conn, reports, creds))


def test_missing_ingest_meta(tmp_path):
    conn, reports, creds = healthy(tmp_path)
    conn.execute("DELETE FROM meta")
    conn.commit()
    assert any("ingest" in x for x in _check(conn, reports, creds))


def test_missing_yesterday_brief(tmp_path):
    conn, reports, creds = healthy(tmp_path)
    (reports / "2026" / "07" / "2026-07-31-brief.md").unlink()
    assert any("brief" in x for x in _check(conn, reports, creds))


def test_stuck_wakeup(tmp_path):
    conn, reports, creds = healthy(tmp_path)
    wakeup.add(conn, "2026-08-01T05:00:00Z", "deepdive", "t")  # 60 min overdue
    assert any("wakeup" in x for x in _check(conn, reports, creds))


def test_run_sends_single_telegram_on_violation(tmp_path, monkeypatch):
    conn, reports, creds = healthy(tmp_path)
    db.set_meta(conn, "last_ingest_at", "2026-08-01T04:00:00Z")
    sent = []
    monkeypatch.setattr(watchdog.runner, "_notify_safe", lambda c, s, t: sent.append(t))
    v = watchdog.run(conn, {}, reports, now=NOW, credentials_path=creds)
    assert v and len(sent) == 1 and "Jamasp watchdog" in sent[0]


# ---- credential expiry ------------------------------------------------------
# The 2026-08-28 outage: the OAuth REFRESH token expired and every
# Claude-dependent path went dark for 3.5 days. Frequent use did not extend
# it, so the only warning available is the timestamp itself.

def test_credentials_far_from_expiry_is_silent(tmp_path):
    conn, reports, _ = healthy(tmp_path)
    creds = _creds(tmp_path, refresh_in_days=30)
    assert _check(conn, reports, creds) == []


def _cred_violations(v):
    """The credential-related violations. Every one names Claude."""
    return [x for x in v if "claude" in x.lower()]


def test_credentials_expiring_inside_the_window_violates(tmp_path):
    conn, reports, _ = healthy(tmp_path)
    creds = _creds(tmp_path, refresh_in_days=2)
    got = _cred_violations(_check(conn, reports, creds))
    assert got, "expected a warning inside the window"
    # Names the token that actually lapses, and when. "expires soon" would
    # leave the operator unable to tell urgent from routine.
    assert "refresh token" in got[0].lower(), got
    assert "2026-08-03" in got[0], got


def test_credentials_already_expired_violates(tmp_path):
    conn, reports, _ = healthy(tmp_path)
    creds = _creds(tmp_path, refresh_in_days=-1)
    got = _cred_violations(_check(conn, reports, creds))
    assert got and "expired" in got[0].lower(), got
    # An already-dead credential is not the same as one lapsing on Friday,
    # and the message has to let the desk tell them apart at a glance.
    assert "EXPIRED" in got[0], got


def test_the_warning_window_edge(tmp_path):
    # Just outside the window stays silent; just inside violates. Pins the
    # threshold itself rather than "some number produced some violation".
    conn, reports, _ = healthy(tmp_path)
    outside_dir = tmp_path / "outside"
    inside_dir = tmp_path / "inside"
    outside_dir.mkdir()
    inside_dir.mkdir()
    outside = _creds(outside_dir, refresh_in_days=watchdog.CREDENTIALS_WARN_DAYS + 1)
    inside = _creds(inside_dir, refresh_in_days=watchdog.CREDENTIALS_WARN_DAYS - 1)
    assert _check(conn, reports, outside) == []
    assert _check(conn, reports, inside) != []


def test_missing_credentials_file_violates(tmp_path):
    # No credentials at all means no agent run can succeed. Staying quiet
    # here is the silence this whole module exists to prevent.
    conn, reports, _ = healthy(tmp_path)
    v = _check(conn, reports, tmp_path / "nope.json")
    assert any("credentials" in x.lower() for x in v), v


def test_malformed_credentials_file_violates(tmp_path):
    conn, reports, _ = healthy(tmp_path)
    creds = _creds(tmp_path, body="{ truncated")
    v = _check(conn, reports, creds)
    assert any("credentials" in x.lower() for x in v), v


def test_credentials_without_the_expiry_field_violates(tmp_path):
    # Cannot verify is not the same as fine.
    conn, reports, _ = healthy(tmp_path)
    creds = _creds(tmp_path, body=json.dumps({"claudeAiOauth": {"subscriptionType": "max"}}))
    v = _check(conn, reports, creds)
    assert any("credentials" in x.lower() for x in v), v


def test_expiry_accepts_seconds_as_well_as_milliseconds(tmp_path):
    # Claude writes milliseconds today. A seconds value must not be read as
    # 1970, which would look like a permanently expired credential.
    conn, reports, _ = healthy(tmp_path)
    now = datetime.strptime(NOW, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    secs = int((now + timedelta(days=30)).timestamp())
    creds = _creds(tmp_path, body=json.dumps(
        {"claudeAiOauth": {"refreshTokenExpiresAt": secs}}))
    assert _check(conn, reports, creds) == []


def test_the_violation_says_what_to_do(tmp_path):
    # An alert that names the fix ends the incident; one that does not costs
    # days. That is the whole lesson of docs/todo/007.
    conn, reports, _ = healthy(tmp_path)
    for days in (-1, 2):
        got = _cred_violations(_check(conn, reports, _creds(tmp_path, refresh_in_days=days)))
        assert got, days
        assert "re-authenticate" in got[0], got
        assert "service user" in got[0], got
    # ...and so does the case where the file is not there at all.
    got = _cred_violations(_check(conn, reports, tmp_path / "nope.json"))
    assert got and "re-authenticate" in got[0], got
