from jamasp.alert import MAX_MESSAGE_CHARS, compose, gather


class FakeRunner:
    """Stands in for subprocess.run, keyed on the command being invoked."""

    def __init__(self, show=None, journal=None, fail=None):
        self.show = show or {}
        self.journal = journal if journal is not None else ""
        self.fail = fail or set()
        self.calls = []

    def __call__(self, argv):
        self.calls.append(argv)
        if argv[0] in self.fail:
            raise OSError(f"{argv[0]} not found")
        if argv[0] == "systemctl":
            # `systemctl show -p A -p B --value UNIT` returns one line per
            # property, in the order requested.
            props = [a for i, a in enumerate(argv) if argv[i - 1] == "-p"]
            return "\n".join(self.show.get(p, "") for p in props)
        return self.journal


def test_gather_collects_state_and_journal():
    run = FakeRunner(
        show={
            "Result": "exit-code",
            "ExecMainStatus": "1",
            "ActiveState": "failed",
            "SubState": "failed",
            "Description": "Jamasp panel — Access JWT sidecar",
        },
        journal="line one\nline two",
    )
    info = gather("jamasp-authd.service", run=run)

    assert info["Result"] == "exit-code"
    assert info["ExecMainStatus"] == "1"
    assert info["journal"] == "line one\nline two"


def test_compose_includes_the_unit_and_its_state():
    msg = compose(
        "jamasp-authd.service",
        {
            "Result": "exit-code",
            "ExecMainStatus": "1",
            "ActiveState": "failed",
            "SubState": "failed",
            "Description": "the sidecar",
            "journal": "Traceback: boom",
        },
    )

    assert "jamasp-authd.service" in msg
    assert "exit-code" in msg
    assert "Traceback: boom" in msg


def test_compose_says_so_when_the_journal_is_unreadable():
    """The trap this guards against: journalctl returns an empty string rather
    than an error when the caller lacks permission, so a blank log section
    would look like 'the unit failed quietly' instead of 'we cannot see'."""
    msg = compose(
        "certbot.service",
        {
            "Result": "exit-code",
            "ExecMainStatus": "1",
            "ActiveState": "failed",
            "SubState": "failed",
            "Description": "certbot",
            "journal": "",
        },
    )

    assert "no journal lines" in msg.lower()
    assert "systemd-journal" in msg


def test_compose_is_capped_for_telegram():
    """Telegram rejects messages over 4096 chars; a noisy traceback must not
    turn a failure alert into a failed alert."""
    msg = compose(
        "jamasp-ingest.service",
        {
            "Result": "exit-code",
            "ExecMainStatus": "1",
            "ActiveState": "failed",
            "SubState": "failed",
            "Description": "ingest",
            "journal": "x" * 20000,
        },
    )

    assert len(msg) <= MAX_MESSAGE_CHARS
    assert "truncated" in msg.lower()


def test_compose_leads_in_persian_and_keeps_detail_in_english():
    msg = compose(
        "jamasp-authd.service",
        {
            "Result": "exit-code",
            "ExecMainStatus": "1",
            "ActiveState": "failed",
            "SubState": "failed",
            "Description": "sidecar",
            "journal": "boom",
        },
    )

    first = msg.splitlines()[0]
    assert any("؀" <= ch <= "ۿ" for ch in first), "lead line should be Persian"
    assert "unit:" in msg, "technical body stays English for desk clarity"


def test_gather_survives_a_missing_journalctl():
    """A tool that isn't installed must not turn into a crashed alert unit."""
    run = FakeRunner(
        show={"Result": "exit-code", "ActiveState": "failed"},
        fail={"journalctl"},
    )
    info = gather("jamasp-authd.service", run=run)

    assert info["journal"] == ""
    assert info["Result"] == "exit-code"


def test_gather_survives_a_missing_systemctl():
    run = FakeRunner(journal="some log", fail={"systemctl"})
    info = gather("jamasp-authd.service", run=run)

    assert info["journal"] == "some log"
    assert info["Result"] == ""


def test_compose_handles_a_totally_blind_gather():
    """Both tools unavailable — still send something naming the unit."""
    msg = compose("jamasp-authd.service", {"journal": ""})
    assert "jamasp-authd.service" in msg


# --- rate limiting -----------------------------------------------------
#
# jamasp-dispatch fires every 5 minutes. Without a suppression window a
# persistent failure would send ~288 messages a day, and an alert channel
# that storms is one people mute.

from jamasp import db as db_mod
from jamasp.alert import ALERT_WINDOW_MINUTES, should_send


def _conn(tmp_path):
    return db_mod.connect(tmp_path / "t.db")


def test_first_failure_always_sends(tmp_path):
    conn = _conn(tmp_path)
    assert should_send(conn, "jamasp-dispatch.service", now="2026-08-09T10:00:00Z")


def test_repeat_inside_the_window_is_suppressed(tmp_path):
    conn = _conn(tmp_path)
    assert should_send(conn, "jamasp-dispatch.service", now="2026-08-09T10:00:00Z")
    assert not should_send(conn, "jamasp-dispatch.service", now="2026-08-09T10:05:00Z")
    assert not should_send(conn, "jamasp-dispatch.service", now="2026-08-09T10:59:00Z")


def test_repeat_after_the_window_sends_again(tmp_path):
    conn = _conn(tmp_path)
    assert should_send(conn, "jamasp-dispatch.service", now="2026-08-09T10:00:00Z")
    later = "2026-08-09T11:01:00Z"
    assert should_send(conn, "jamasp-dispatch.service", now=later)


def test_a_different_unit_is_not_suppressed(tmp_path):
    """Suppression is per unit — one noisy unit must not mask another."""
    conn = _conn(tmp_path)
    assert should_send(conn, "jamasp-dispatch.service", now="2026-08-09T10:00:00Z")
    assert should_send(conn, "jamasp-authd.service", now="2026-08-09T10:01:00Z")


def test_window_is_an_hour():
    assert ALERT_WINDOW_MINUTES == 60


def test_corrupt_timestamp_does_not_suppress(tmp_path):
    """Fail open on a bad stored value: a missed alert is worse than a
    duplicate one."""
    conn = _conn(tmp_path)
    db_mod.set_meta(conn, "alert_last.jamasp-authd.service", "not-a-timestamp")
    assert should_send(conn, "jamasp-authd.service", now="2026-08-09T10:00:00Z")


# --- the alerter's own failure must not be silent -----------------------

from click.testing import CliRunner

from jamasp.cli import main


def _cfg(tmp_path):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "settings.yaml").write_text(
        "telegram:\n"
        "  bot_token_env: JAMASP_TG_TOKEN\n"
        "  chat_id_env: JAMASP_TG_CHAT\n"
    )
    (cfg / "sources.yaml").write_text("sources: []\n")
    return cfg


def test_alert_exits_nonzero_when_the_send_fails(tmp_path, monkeypatch):
    """If delivery fails the unit must land in `failed`, not report success.

    jamasp-alert@.service deliberately has no OnFailure= of its own (that
    would loop), so a silent exit 0 is the difference between 'shows up in
    systemctl --failed' and 'nobody ever finds out alerting is broken'.
    """
    monkeypatch.delenv("JAMASP_TG_TOKEN", raising=False)
    cfg = _cfg(tmp_path)

    result = CliRunner().invoke(
        main,
        ["alert", "some.service", "--db", str(tmp_path / "t.db"), "--config-dir", str(cfg)],
    )

    assert result.exit_code != 0
    assert "FAILED" in result.output or "FAILED" in str(result.exception or "")


def test_alert_exits_zero_on_a_successful_send(tmp_path, monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "t")
    monkeypatch.setenv("JAMASP_TG_CHAT", "c")
    monkeypatch.setattr(
        "jamasp.notify._default_post",
        lambda url, data: {"ok": True, "result": {"message_id": 1}},
    )
    cfg = _cfg(tmp_path)

    result = CliRunner().invoke(
        main,
        ["alert", "some.service", "--db", str(tmp_path / "t.db"), "--config-dir", str(cfg)],
    )

    assert result.exit_code == 0, result.output


def test_no_entries_marker_counts_as_unreadable():
    """journalctl does not return an empty string when it has nothing to show
    — it prints the literal `-- No entries --` to stdout, which is truthy.

    That is precisely what a permission problem looks like: the jamasp user
    outside the systemd-journal group gets this marker, not an error. Treating
    it as content renders 'the unit logged nothing' and hides the actual
    cause, which is the failure mode the explicit branch exists to prevent.
    """
    run = FakeRunner(show={"Result": "exit-code"}, journal="-- No entries --")
    info = gather("nginx.service", run=run)

    assert info["journal"] == ""
    assert "systemd-journal" in compose("nginx.service", info)


def test_no_entries_marker_is_matched_case_insensitively():
    run = FakeRunner(show={}, journal="  -- no entries --  ")
    assert gather("nginx.service", run=run)["journal"] == ""


def test_real_log_lines_are_kept():
    run = FakeRunner(show={}, journal="Aug 09 16:03 Jamasp sh[1]: SELFTEST")
    assert "SELFTEST" in gather("nginx.service", run=run)["journal"]
