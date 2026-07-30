from pathlib import Path

from jamasp import db
from jamasp.config import Source
from jamasp.ingest import rss

FIXTURES = Path(__file__).parent / "fixtures"
SRC = Source("fxstreet", "rss", "https://x.example/rss", 15, "markets")


def _items():
    return rss.parse_feed(SRC, (FIXTURES / "feed_fxstreet.xml").read_bytes())


def test_parse_feed_extracts_items():
    items = _items()
    assert len(items) == 2
    first = items[0]
    assert first.headline == "Gold climbs as dollar softens ahead of Fed decision"
    assert first.url == "https://www.fxstreet.com/news/gold-climbs-1"
    assert first.published_at == "2026-07-30T14:05:00Z"
    assert first.source == "fxstreet"
    assert first.topic == "markets"
    assert first.id == rss.item_id("fxstreet", first.url, first.headline)


def test_item_id_is_stable_and_short():
    a = rss.item_id("s", "u", "h")
    assert a == rss.item_id("s", "u", "h") and len(a) == 16


def test_store_items_dedupes(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    items = _items()
    assert rss.store_items(conn, items) == 2
    assert rss.store_items(conn, items) == 0  # same ids: ignored
    n = conn.execute("SELECT COUNT(*) c FROM items").fetchone()["c"]
    assert n == 2
