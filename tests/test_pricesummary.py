from jamasp import db, pricesummary
from jamasp.ingest import prices


def test_render_with_deltas(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    prices.store_price(conn, "XAUUSD", "2026-07-29T08:00:00Z", 3390.0)
    prices.store_price(conn, "XAUUSD", "2026-07-30T08:00:00Z", 3412.55)
    out = pricesummary.render(conn, now="2026-07-30T09:00:00Z")
    assert "XAUUSD 3412.55" in out
    assert "24h: +0.67%" in out
    assert "7d: n/a" in out


def test_render_empty_db(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    assert pricesummary.render(conn) == "no price data"
