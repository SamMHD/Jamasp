from jamasp import db, pricesummary
from jamasp.ingest import prices


def test_render_with_deltas(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    prices.store_price(conn, "XAUUSD", "2026-07-29T08:00:00Z", 3390.0)
    prices.store_price(conn, "XAUUSD", "2026-07-30T08:00:00Z", 3412.55)
    out = pricesummary.render(conn, now="2026-07-30T09:00:00Z")
    assert "XAUUSD 3412.55 @2026-07-30" in out
    assert "24h: +0.67%" in out
    assert "7d: n/a" in out


def test_render_empty_db(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    assert pricesummary.render(conn) == "no price data"


def test_stale_series_shows_na_not_zero(tmp_path):
    # A FRED-style series with only one (stale) observation: the 24h/7d
    # reference resolves to the same observation as "latest", so there is
    # nothing to diff against -> must show n/a, never a fabricated +0.00%.
    conn = db.connect(tmp_path / "t.db")
    prices.store_price(conn, "DGS10", "2026-07-20T00:00:00Z", 4.25)
    out = pricesummary.render(conn, now="2026-07-30T09:00:00Z")
    assert "DGS10 4.25 @2026-07-20" in out
    assert "24h: n/a" in out
    assert "7d: n/a" in out
    assert "+0.00%" not in out
