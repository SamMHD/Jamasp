import json
from pathlib import Path

from click.testing import CliRunner

from jamasp import db
from jamasp.cli import main
from jamasp.ingest import rss
from jamasp.models import Item

FIXTURES = Path(__file__).parent / "fixtures"


def _write_configs(tmp_path, sources_yaml):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "sources.yaml").write_text(sources_yaml)
    (cfg / "settings.yaml").write_text(
        "timezone: Asia/Dubai\ninbox_cap: 120\nextract_max_chars: 16000\n"
        "digest:\n  claude_cmd: [\"/nonexistent\"]\n  batch_max_items: 60\n"
        "cluster:\n  similarity_threshold: 80\n  window_hours: 48\n"
        "telegram:\n  bot_token_env: JAMASP_TG_TOKEN\n  chat_id_env: JAMASP_TG_CHAT\n"
    )
    return cfg


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
