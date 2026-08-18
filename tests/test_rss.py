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


# Mining Weekly's feed carries a correct <pubDate> next to non-standard
# <published>/<updated> elements holding a raw Unix epoch. feedparser prefers
# the Atom-style names and mis-parses the integer as a date string, taking its
# first four digits as a year: every item landed in 1786, always outside the
# 6h flash window, so the source posted nothing in 119 items.
MINING = Source("mining_weekly", "rss", "https://x.example/rss", 30, "gold")


def _epoch_items():
    return rss.parse_feed(
        MINING, (FIXTURES / "feed_epoch_published.xml").read_bytes()
    )


def test_parse_feed_recovers_a_raw_epoch_published_element():
    items = _epoch_items()
    assert len(items) == 2
    # 1786971720 is 2026-08-17T13:02:00Z — the same instant as the pubDate
    assert items[0].published_at == "2026-08-17T13:02:00Z"
    assert items[1].published_at == "2026-08-17T09:46:00Z"


def test_parse_feed_never_yields_an_absurd_publish_date():
    for item in _epoch_items():
        assert item.published_at > "2000-", item.published_at


def test_published_at_rejects_a_year_parsed_out_of_a_raw_epoch():
    """The exact production shape: feedparser read '1786971720' as year 1786."""
    import time
    entry = {
        "published_parsed": time.struct_time((1786, 8, 1, 0, 0, 0, 0, 1, 0)),
        "published": "1786971720",
    }
    assert rss._published_at(entry) == "2026-08-17T13:02:00Z"


def test_published_at_uses_a_sane_parsed_date_over_the_epoch_field():
    import time
    entry = {
        "published_parsed": time.struct_time((2026, 7, 30, 14, 5, 0, 0, 1, 0)),
        "published": "1786971720",
    }
    assert rss._published_at(entry) == "2026-07-30T14:05:00Z"


def test_published_at_falls_back_to_now_when_nothing_is_usable():
    assert rss._published_at({"published": "not-a-date"}).startswith("20")
