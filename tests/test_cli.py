import json
import sys
from pathlib import Path

from click.testing import CliRunner

from jamasp import db
from jamasp.cli import main
from jamasp.ingest import rss
from jamasp.models import Item

FIXTURES = Path(__file__).parent / "fixtures"
FAKE_AGENT = str(Path(__file__).parent / "fake_agent.py")


def _write_configs(tmp_path, sources_yaml, extra_settings_yaml=""):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "sources.yaml").write_text(sources_yaml)
    (cfg / "settings.yaml").write_text(
        "timezone: Asia/Dubai\ninbox_cap: 120\nextract_max_chars: 16000\n"
        "digest:\n  claude_cmd: [\"/nonexistent\"]\n  batch_max_items: 60\n"
        "cluster:\n  similarity_threshold: 80\n  window_hours: 48\n"
        "telegram:\n  bot_token_env: JAMASP_TG_TOKEN\n  chat_id_env: JAMASP_TG_CHAT\n"
        + extra_settings_yaml
    )
    return cfg


def _runs_yaml(mode):
    """A `runs:` settings block whose claude_cmd is tests/fake_agent.py in MODE."""
    return (
        "runs:\n"
        f"  claude_cmd: [{json.dumps(sys.executable)}, {json.dumps(FAKE_AGENT)}, {json.dumps(mode)}]\n"
        "  max_agent_runs_per_day: 20\n"
        "  timeouts_seconds:\n    brief: 900\n    deepdive: 900\n    scan: 300\n    retro: 1200\n"
    )


def test_ingest_survives_dead_source_and_reports(tmp_path, monkeypatch):
    cfg = _write_configs(
        tmp_path,
        """
sources:
  - name: deadfeed
    type: rss
    url: http://127.0.0.1:1/rss
    interval_minutes: 15
    topic: markets
""",
    )
    dbp = tmp_path / "j.db"
    runner = CliRunner()
    result = runner.invoke(
        main, ["ingest", "--no-digest", "--db", str(dbp), "--config-dir", str(cfg)]
    )
    assert result.exit_code == 0
    conn = db.connect(dbp)
    errs = conn.execute("SELECT source FROM source_errors").fetchall()
    assert [e["source"] for e in errs] == ["deadfeed"]


def test_ingest_skips_source_fetched_within_interval(tmp_path):
    cfg = _write_configs(
        tmp_path,
        """
sources:
  - name: deadfeed
    type: rss
    url: http://127.0.0.1:1/rss
    interval_minutes: 60
    topic: markets
""",
    )
    dbp = tmp_path / "j.db"
    conn = db.connect(dbp)
    db.set_meta(conn, "source_last_fetch.deadfeed", db.utcnow())
    conn.close()
    runner = CliRunner()
    result = runner.invoke(
        main, ["ingest", "--no-digest", "--db", str(dbp), "--config-dir", str(cfg)]
    )
    assert result.exit_code == 0
    conn = db.connect(dbp)
    # within the 60-minute interval -> no fetch attempt, so no error either
    assert conn.execute("SELECT COUNT(*) c FROM source_errors").fetchone()["c"] == 0

    # age the marker past the interval -> the source is fetched (and fails)
    db.set_meta(conn, "source_last_fetch.deadfeed", "2026-01-01T00:00:00Z")
    conn.close()
    result = runner.invoke(
        main, ["ingest", "--no-digest", "--db", str(dbp), "--config-dir", str(cfg)]
    )
    assert result.exit_code == 0
    conn = db.connect(dbp)
    assert conn.execute("SELECT COUNT(*) c FROM source_errors").fetchone()["c"] == 1


def test_ingest_records_last_fetch_only_on_success(tmp_path, monkeypatch):
    cfg = _write_configs(
        tmp_path,
        """
sources:
  - name: goodfeed
    type: rss
    url: http://127.0.0.1:1/rss
    interval_minutes: 60
    topic: markets
  - name: deadfeed
    type: rss
    url: http://127.0.0.1:1/rss
    interval_minutes: 60
    topic: markets
""",
    )
    from jamasp import cli as cli_mod

    real_fetch = cli_mod.rss_mod.fetch_source

    def fake_fetch(source, client):
        if source.name == "goodfeed":
            return []
        return real_fetch(source, client)

    monkeypatch.setattr(cli_mod.rss_mod, "fetch_source", fake_fetch)
    dbp = tmp_path / "j.db"
    runner = CliRunner()
    result = runner.invoke(
        main, ["ingest", "--no-digest", "--db", str(dbp), "--config-dir", str(cfg)]
    )
    assert result.exit_code == 0
    conn = db.connect(dbp)
    assert db.get_meta(conn, "source_last_fetch.goodfeed") is not None
    # a failed fetch must NOT set the marker, so the source retries next run
    assert db.get_meta(conn, "source_last_fetch.deadfeed") is None


def test_inbox_command_renders_and_marks(tmp_path):
    cfg = _write_configs(tmp_path, "sources: []\n")
    dbp = tmp_path / "j.db"
    conn = db.connect(dbp)
    it = Item(
        id=rss.item_id("s", "https://e/1", "Gold pops"),
        source="s", published_at="2026-07-30T10:00:00Z",
        headline="Gold pops", url="https://e/1", topic="gold",
    )
    rss.store_items(conn, [it])
    conn.execute("UPDATE items SET cluster_id = id")
    conn.commit()
    runner = CliRunner()
    out = runner.invoke(main, ["inbox", "--db", str(dbp), "--config-dir", str(cfg)])
    assert out.exit_code == 0
    line = [l for l in out.output.splitlines() if not l.startswith("#")][0]
    assert json.loads(line)["head"] == "Gold pops"
    marked = runner.invoke(
        main, ["inbox", "--mark-read", "--db", str(dbp), "--config-dir", str(cfg)]
    )
    assert "marked 1 items read" in marked.output


def test_notify_dry_run(tmp_path, monkeypatch):
    cfg = _write_configs(tmp_path, "sources: []\n")
    monkeypatch.setenv("JAMASP_TG_TOKEN", "T")
    monkeypatch.setenv("JAMASP_TG_CHAT", "C")
    runner = CliRunner()
    out = runner.invoke(
        main,
        ["notify", "--dry-run", "hello", "--db", str(tmp_path / "j.db"), "--config-dir", str(cfg)],
    )
    assert out.exit_code == 0
    assert "[dry-run] would send 5 chars" in out.output


def test_notify_cli_logs_sent_message(tmp_path, monkeypatch):
    """`jamasp notify` records the message in notify_log on success."""
    from click.testing import CliRunner
    from jamasp import cli, db as db_mod, notify as notify_mod

    monkeypatch.setenv("JAMASP_TG_TOKEN", "tok")
    monkeypatch.setenv("JAMASP_TG_CHAT", "chat")
    monkeypatch.setattr(
        notify_mod, "send_telegram", lambda text, token, chat_id, post=None: None
    )
    db_path = tmp_path / "t.db"
    result = CliRunner().invoke(
        cli.main, ["notify", "hello desk", "--db", str(db_path), "--config-dir", "config"]
    )
    assert result.exit_code == 0, result.output
    conn = db_mod.connect(db_path)
    rows = conn.execute("SELECT text, ok FROM notify_log").fetchall()
    assert [(r["text"], r["ok"]) for r in rows] == [("hello desk", 1)]


def test_notify_cli_dry_run_does_not_log(tmp_path):
    from click.testing import CliRunner
    from jamasp import cli, db as db_mod

    db_path = tmp_path / "t.db"
    result = CliRunner().invoke(
        cli.main,
        ["notify", "x", "--dry-run", "--db", str(db_path), "--config-dir", "config"],
    )
    # dry-run may still fail on missing env vars in some environments; the
    # invariant is simply: no notify_log rows are written.
    conn = db_mod.connect(db_path)
    assert conn.execute("SELECT COUNT(*) FROM notify_log").fetchone()[0] == 0


def test_run_cmd_ok_exits_zero(tmp_path, monkeypatch):
    monkeypatch.delenv("JAMASP_TG_TOKEN", raising=False)
    monkeypatch.delenv("JAMASP_TG_CHAT", raising=False)
    cfg = _write_configs(tmp_path, "sources: []\n", _runs_yaml("ok"))
    dbp = tmp_path / "j.db"
    runner = CliRunner()
    out = runner.invoke(main, ["run", "scan", "--db", str(dbp), "--config-dir", str(cfg)])
    assert out.exit_code == 0
    assert "scan: ok" in out.output
    conn = db.connect(dbp)
    rows = conn.execute("SELECT status FROM agent_runs").fetchall()
    assert [r["status"] for r in rows] == ["ok"]


def test_run_cmd_persistent_failure_exits_nonzero(tmp_path, monkeypatch):
    # no Telegram env vars set -> the failure notice is swallowed by _notify_safe,
    # so the CLI exit code is unaffected by Telegram availability.
    monkeypatch.delenv("JAMASP_TG_TOKEN", raising=False)
    monkeypatch.delenv("JAMASP_TG_CHAT", raising=False)
    cfg = _write_configs(tmp_path, "sources: []\n", _runs_yaml("fail"))
    dbp = tmp_path / "j.db"
    runner = CliRunner()
    out = runner.invoke(main, ["run", "scan", "--db", str(dbp), "--config-dir", str(cfg)])
    assert out.exit_code != 0
    assert "scan: failed" in out.output
    conn = db.connect(dbp)
    rows = conn.execute("SELECT status FROM agent_runs").fetchall()
    assert [r["status"] for r in rows] == ["failed"]


def test_run_cmd_dry_run_executes_and_records_nothing(tmp_path, monkeypatch):
    monkeypatch.delenv("JAMASP_TG_TOKEN", raising=False)
    monkeypatch.delenv("JAMASP_TG_CHAT", raising=False)
    cfg = _write_configs(tmp_path, "sources: []\n", _runs_yaml("ok"))
    dbp = tmp_path / "j.db"
    runner = CliRunner()
    out = runner.invoke(main, ["run", "scan", "--dry-run", "--db", str(dbp), "--config-dir", str(cfg)])
    assert out.exit_code == 0
    assert "[dry-run] would run:" in out.output
    assert "/scan" in out.output
    conn = db.connect(dbp)
    rows = conn.execute("SELECT status FROM agent_runs").fetchall()
    assert rows == []
