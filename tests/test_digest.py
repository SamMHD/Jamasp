import sys
from pathlib import Path

from jamasp import db, digest
from jamasp.ingest import rss
from jamasp.models import Item

FAKE = [sys.executable, str(Path(__file__).parent / "fake_claude.py")]


def _seed(conn, n=3):
    items = [
        Item(
            id=rss.item_id("s", f"https://e/{i}", f"Headline number {i}"),
            source="s",
            published_at="2026-07-30T10:00:00Z",
            headline=f"Headline number {i}",
            url=f"https://e/{i}",
            topic="gold",
        )
        for i in range(n)
    ]
    rss.store_items(conn, items)
    return items


def test_parse_response_tolerates_fences():
    text = 'Here you go:\n```json\n{"abc": "a lede"}\n```\nDone.'
    assert digest.parse_response(text) == {"abc": "a lede"}


def test_run_digest_fills_ledes(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    items = _seed(conn)
    settings = {"digest": {"claude_cmd": FAKE, "batch_max_items": 60}}
    assert digest.run_digest(conn, settings) == 3
    row = conn.execute("SELECT lede FROM items WHERE id = ?", (items[0].id,)).fetchone()
    assert row["lede"] == f"LEDE for {items[0].id}"
    # second run: nothing left to do, no subprocess needed
    assert digest.run_digest(conn, settings) == 0


def test_run_digest_survives_broken_cli(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    items = _seed(conn)
    settings = {"digest": {"claude_cmd": ["/nonexistent/claude"], "batch_max_items": 60}}
    assert digest.run_digest(conn, settings) == 0  # no crash, ledes stay NULL
    # verify ledes remain NULL
    row = conn.execute("SELECT lede FROM items WHERE id = ?", (items[0].id,)).fetchone()
    assert row["lede"] is None
    # verify error was logged to source_errors
    error_row = conn.execute(
        "SELECT source, error FROM source_errors WHERE source = 'digest'"
    ).fetchone()
    assert error_row is not None
    assert error_row["source"] == "digest"
    assert len(error_row["error"]) > 0


def test_run_digest_survives_unparseable_output(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    items = _seed(conn)
    # CLI that exits successfully but prints garbage (no JSON)
    settings = {
        "digest": {
            "claude_cmd": [sys.executable, "-c", "print('no json here')"],
            "batch_max_items": 60,
        }
    }
    assert digest.run_digest(conn, settings) == 0  # no crash, ledes stay NULL
    # verify ledes remain NULL
    row = conn.execute("SELECT lede FROM items WHERE id = ?", (items[0].id,)).fetchone()
    assert row["lede"] is None
    # verify error was logged to source_errors
    error_row = conn.execute(
        "SELECT source, error FROM source_errors WHERE source = 'digest'"
    ).fetchone()
    assert error_row is not None
    assert error_row["source"] == "digest"
    assert "no JSON object in response" in error_row["error"]


def test_run_digest_respects_batch_max_items(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    items = _seed(conn, n=5)  # seed 5 items
    settings = {"digest": {"claude_cmd": FAKE, "batch_max_items": 2}}  # cap at 2
    assert digest.run_digest(conn, settings) == 2  # only 2 processed
    # verify exactly 2 items have non-NULL ledes
    rows_with_ledes = conn.execute(
        "SELECT COUNT(*) as cnt FROM items WHERE lede IS NOT NULL"
    ).fetchone()
    assert rows_with_ledes["cnt"] == 2
    # verify exactly 3 items still have NULL ledes
    rows_without_ledes = conn.execute(
        "SELECT COUNT(*) as cnt FROM items WHERE lede IS NULL"
    ).fetchone()
    assert rows_without_ledes["cnt"] == 3
