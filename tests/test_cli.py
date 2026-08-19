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
    import itertools

    from jamasp import runner as runner_mod

    monkeypatch.delenv("JAMASP_TG_TOKEN", raising=False)
    monkeypatch.delenv("JAMASP_TG_CHAT", raising=False)
    # HEAD has to move for the run to count as done — the fake agent commits
    # nothing, so without this it is correctly reported `empty`.
    counter = itertools.count()
    monkeypatch.setattr(runner_mod, "_git_head", lambda: f"head{next(counter)}")
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


def test_flash_command_reports_stats(tmp_path, monkeypatch):
    from click.testing import CliRunner

    from jamasp import cli, flash as flash_mod

    called = {}

    def fake_run_flash(conn, settings, sources, **kwargs):
        called["dry_run"] = kwargs.get("dry_run")
        return {"posted": 2, "dup": 1, "not_gold": 3, "unreadable": 0, "stale": 4,
                "burst": 0, "errors": 0}

    monkeypatch.setattr(flash_mod, "run_flash", fake_run_flash)
    result = CliRunner().invoke(
        cli.main, ["flash", "--db", str(tmp_path / "t.db")]
    )
    assert result.exit_code == 0
    assert "2 posted" in result.output and "1 updated" in result.output
    assert called["dry_run"] is False


def test_flash_dry_run_passes_flag(tmp_path, monkeypatch):
    from click.testing import CliRunner

    from jamasp import cli, flash as flash_mod

    called = {}

    def fake_run_flash(conn, settings, sources, **kwargs):
        called["dry_run"] = kwargs.get("dry_run")
        return {"posted": 0, "dup": 0, "not_gold": 0, "unreadable": 0, "stale": 0,
                "burst": 0, "errors": 0}

    monkeypatch.setattr(flash_mod, "run_flash", fake_run_flash)
    result = CliRunner().invoke(
        cli.main, ["flash", "--dry-run", "--db", str(tmp_path / "t.db")]
    )
    assert result.exit_code == 0
    assert called["dry_run"] is True


def test_ingest_no_flash_skips_the_pass(tmp_path, monkeypatch):
    from jamasp import flash as flash_mod

    cfg = _write_configs(
        tmp_path,
        """
sources:
  - name: deadfeed
    type: rss
    url: http://127.0.0.1:1/rss
    interval_minutes: 15
    topic: gold
""",
    )
    calls = []
    monkeypatch.setattr(flash_mod, "run_flash", lambda *a, **k: calls.append(1) or {})
    result = CliRunner().invoke(
        main,
        [
            "ingest", "--no-digest", "--no-flash",
            "--db", str(tmp_path / "j.db"), "--config-dir", str(cfg),
        ],
    )
    assert result.exit_code == 0
    assert calls == []


def test_ingest_heartbeat_lands_before_the_flash_pass(tmp_path, monkeypatch):
    # watchdog.check reads last_ingest_at with a 60-minute staleness bound.
    # The fetch is done and committed before flash starts, so the heartbeat
    # must not be gated on however long flash takes.
    from jamasp import db as db_mod, flash as flash_mod

    cfg = _write_configs(
        tmp_path,
        """
sources:
  - name: deadfeed
    type: rss
    url: http://127.0.0.1:1/rss
    interval_minutes: 15
    topic: gold
""",
    )
    seen = {}

    def fake_run_flash(conn, settings, sources, **kwargs):
        seen["heartbeat"] = db_mod.get_meta(conn, "last_ingest_at")
        return {}

    monkeypatch.setattr(flash_mod, "run_flash", fake_run_flash)
    result = CliRunner().invoke(
        main,
        [
            "ingest", "--no-digest",
            "--db", str(tmp_path / "j.db"), "--config-dir", str(cfg),
        ],
    )
    assert result.exit_code == 0
    assert seen["heartbeat"] is not None


def test_ingest_runs_flash_by_default(tmp_path, monkeypatch):
    from jamasp import flash as flash_mod

    cfg = _write_configs(
        tmp_path,
        """
sources:
  - name: deadfeed
    type: rss
    url: http://127.0.0.1:1/rss
    interval_minutes: 15
    topic: gold
""",
    )
    calls = []
    stats = {"posted": 1, "dup": 2, "not_gold": 3, "unreadable": 0, "stale": 4,
             "burst": 0, "errors": 0}
    monkeypatch.setattr(
        flash_mod, "run_flash", lambda *a, **k: calls.append(1) or stats
    )
    result = CliRunner().invoke(
        main,
        [
            "ingest", "--no-digest",
            "--db", str(tmp_path / "j.db"), "--config-dir", str(cfg),
        ],
    )
    assert result.exit_code == 0
    assert calls == [1]
    assert "flash: 1 posted, 0 held, 0 low tier, 0 no tier, 0 scored, 2 updated" in result.output


def test_wakeup_cancel_cli(tmp_path):
    from click.testing import CliRunner
    from jamasp import cli

    db = str(tmp_path / "t.db")
    r = CliRunner()
    add = r.invoke(cli.main, ["wakeup", "add", "2030-01-01T00:00:00Z", "scan", "t",
                              "--db", db, "--config-dir", "config"])
    assert add.exit_code == 0, add.output
    wid = add.output.split("#")[1].split(":")[0]
    cancel = r.invoke(cli.main, ["wakeup", "cancel", wid, "--db", db, "--config-dir", "config"])
    assert cancel.exit_code == 0, cancel.output
    assert f"cancelled wakeup #{wid}" in cancel.output
    bad = r.invoke(cli.main, ["wakeup", "cancel", "999", "--db", db, "--config-dir", "config"])
    assert bad.exit_code != 0


def test_extract_prints_freshness_header(tmp_path):
    # The agent must see how old an extract is without having to ask the
    # cache table — a 13 Aug snapshot read as live cost a wrong stance on
    # 16 Aug. The header carries fetched_at and age above the text.
    from datetime import datetime, timedelta, timezone

    cfg = _write_configs(tmp_path, "sources: []\n")
    dbp = tmp_path / "j.db"
    conn = db.connect(dbp)
    two_hours_ago = (datetime.now(timezone.utc) - timedelta(hours=2)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    conn.execute(
        "INSERT INTO extract_cache (url, fetched_at, text) VALUES (?, ?, ?)",
        ("https://aj.example/saudi", two_hours_ago, "two-hour-old snapshot"),
    )
    conn.commit()
    result = CliRunner().invoke(
        main,
        ["extract", "https://aj.example/saudi", "--db", str(dbp), "--config-dir", str(cfg)],
    )
    assert result.exit_code == 0, result.output
    header = result.output.splitlines()[0]
    assert "https://aj.example/saudi" in header
    assert two_hours_ago in header
    assert "2.0h ago" in header
    assert "two-hour-old snapshot" in result.output


def test_extract_fresh_flag_busts_cache(tmp_path, monkeypatch):
    from jamasp import extract as extract_mod

    cfg = _write_configs(tmp_path, "sources: []\n")
    dbp = tmp_path / "j.db"
    conn = db.connect(dbp)
    conn.execute(
        "INSERT INTO extract_cache (url, fetched_at, text) VALUES (?, ?, ?)",
        ("https://aj.example/saudi", "2026-08-13T09:00:00Z", "three-day-old snapshot"),
    )
    conn.commit()
    monkeypatch.setattr(
        extract_mod,
        "_default_fetch",
        lambda url: "<html><body><article><p>" + "Fresh copy of the page. " * 40
        + "</p></article></body></html>",
    )
    result = CliRunner().invoke(
        main,
        ["extract", "https://aj.example/saudi", "--fresh",
         "--db", str(dbp), "--config-dir", str(cfg)],
    )
    assert result.exit_code == 0, result.output
    assert "Fresh copy of the page" in result.output
    assert "three-day-old snapshot" not in result.output


def test_predictions_due_open_flag(tmp_path):
    from jamasp.ingest import prices

    cfg = _write_configs(tmp_path, "sources: []\n")
    dbp = tmp_path / "j.db"
    conn = db.connect(dbp)
    prices.store_price(conn, "GC", "2026-08-12T05:00:00Z", 4468.0)
    prices.store_price(conn, "GC", "2026-08-13T00:35:00Z", 4501.8)
    pred = tmp_path / "p.jsonl"
    r = CliRunner()
    add = r.invoke(main, [
        "predictions", "add", "gold tags 4500 by Friday",
        "--direction", "up", "--horizon-days", "30", "--confidence", "0.8",
        "--path", str(pred), "--db", str(dbp), "--config-dir", str(cfg),
    ])
    assert add.exit_code == 0, add.output

    without = r.invoke(main, [
        "predictions", "due",
        "--path", str(pred), "--db", str(dbp), "--config-dir", str(cfg),
    ])
    assert without.exit_code == 0, without.output
    assert "gold tags 4500" not in without.output

    with_open = r.invoke(main, [
        "predictions", "due", "--open",
        "--path", str(pred), "--db", str(dbp), "--config-dir", str(cfg),
    ])
    assert with_open.exit_code == 0, with_open.output
    assert "gold tags 4500" in with_open.output
    assert "4501.8" in with_open.output
    assert "still open" in with_open.output


def test_run_cmd_empty_exits_zero(tmp_path, monkeypatch):
    # run_agent already Telegrams the desk about an empty run; exiting
    # non-zero would additionally trip the unit's OnFailure alert and
    # notify twice for one event.
    from jamasp import runner as runner_mod

    monkeypatch.delenv("JAMASP_TG_TOKEN", raising=False)
    monkeypatch.delenv("JAMASP_TG_CHAT", raising=False)
    monkeypatch.setattr(runner_mod, "_git_head", lambda: "unchanged")
    cfg = _write_configs(tmp_path, "sources: []\n", _runs_yaml("ok"))
    dbp = tmp_path / "j.db"
    out = CliRunner().invoke(
        main, ["run", "scan", "--db", str(dbp), "--config-dir", str(cfg)]
    )
    assert "scan: empty" in out.output
    assert out.exit_code == 0
    conn = db.connect(dbp)
    rows = conn.execute("SELECT status FROM agent_runs").fetchall()
    assert [r["status"] for r in rows] == ["empty"]


def test_flash_rollup_command_reports_and_dry_runs(tmp_path, monkeypatch):
    from jamasp import flash as flash_mod

    cfg = _write_configs(
        tmp_path, "sources: []\n",
        "flash:\n  enabled: true\n  max_age_hours: 6\n  max_posts_per_tick: 10\n"
        "  classify_batch_max: 30\n  extract_chars: 4000\n"
        '  decide_cmd: ["fake"]\n  write_cmd: ["fake"]\n'
        "  rollup_min_items: 3\n",
    )
    monkeypatch.setattr(
        flash_mod, "run_rollup",
        lambda *a, **k: {"items": 5, "sent": 1, "below_floor": 0, "carried": 2,
                         "errors": 0},
    )
    out = CliRunner().invoke(
        main,
        ["flash-rollup", "--db", str(tmp_path / "j.db"), "--config-dir", str(cfg)],
    )
    assert out.exit_code == 0, out.output
    assert "rollup: 5 items, 1 sent" in out.output
    assert "2 carried" in out.output


def test_flash_line_reports_tier_outcomes():
    # A live tick classified 30 items and the line accounted for 11 of them:
    # held and low-tier were invisible, which is the same conflated-counter
    # mistake that made skipped_stale unreadable.
    from jamasp.cli import _flash_line

    line = _flash_line({
        "posted": 1, "dup": 1, "not_gold": 9, "unreadable": 0, "burst": 0,
        "stale": 0, "born_old": 82, "held": 12, "low_tier": 7, "no_tier": 2,
        "errors": 0, "scored": 23,
    })
    assert "12 held" in line
    assert "7 low tier" in line
    assert "2 no tier" in line
    assert "23 scored" in line
