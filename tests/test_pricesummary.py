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


def test_technicals_collapse_to_one_context_line(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    ts = "2026-07-31T22:00:00Z"
    prices.store_price(conn, "GC", ts, 4107.0)
    for suffix, value in [
        ("RSI14", 49.0847), ("SMA50", 4217.694), ("SMA200", 4496.6535),
        ("ATR14", 99.3796), ("PIV_S1", 3803.5), ("PIV_R1", 4425.4),
    ]:
        prices.store_price(conn, f"GC_{suffix}", ts, value)
    out = pricesummary.render(conn, now="2026-08-01T09:00:00Z")
    assert (
        "GC technicals @2026-07-31: RSI14 49.1, ATR14 99.4, 50DMA 4217.7, "
        "200DMA 4496.7, spot below both, month-pivot S1 3803.5 / R1 4425.4"
    ) in out
    # no generic per-symbol delta lines for technical series
    assert "GC_RSI14" not in out
    # the spot line itself is untouched
    assert "GC 4107 @2026-07-31" in out


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


def _regime_line(tmp_path, name, spot, sma50, sma200):
    conn = db.connect(tmp_path / f"{name}.db")
    ts = "2026-07-31T22:00:00Z"
    prices.store_price(conn, "GC", ts, spot)
    prices.store_price(conn, "GC_SMA50", ts, sma50)
    prices.store_price(conn, "GC_SMA200", ts, sma200)
    return pricesummary.render(conn, now="2026-08-01T09:00:00Z")


def test_all_four_regime_strings(tmp_path):
    # The web panel ports these exact strings — panel/lib/technicals.ts#deriveRegime.
    # Assert all four here so a reworded string fails in CI rather than silently
    # disagreeing with the panel on the desk.
    assert "spot above both" in _regime_line(tmp_path, "a", 4600.0, 4200.0, 4500.0)
    assert "spot below both" in _regime_line(tmp_path, "b", 4100.0, 4200.0, 4500.0)
    assert "spot above 50DMA, below 200DMA" in _regime_line(tmp_path, "c", 4300.0, 4200.0, 4500.0)
    assert "spot below 50DMA, above 200DMA" in _regime_line(tmp_path, "d", 4300.0, 4500.0, 4200.0)


def test_regime_comparison_is_strict(tmp_path):
    # Spot exactly on both SMAs is "below both" — strict `>`, matching the panel.
    assert "spot below both" in _regime_line(tmp_path, "eq", 4200.0, 4200.0, 4200.0)
