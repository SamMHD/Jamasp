from pathlib import Path

from jamasp import db
from jamasp.ingest import prices

FIXTURES = Path(__file__).parent / "fixtures"


def test_parse_stooq_csv():
    symbol, ts, value = prices.parse_stooq_csv((FIXTURES / "stooq_xauusd.csv").read_text())
    assert symbol == "XAUUSD"
    assert ts == "2026-07-30T22:59:52Z"
    assert value == 3412.55


def test_parse_fred_csv_skips_missing():
    symbol, ts, value = prices.parse_fred_csv((FIXTURES / "fred_dfii10.csv").read_text())
    assert symbol == "DFII10"
    assert ts == "2026-07-30T00:00:00Z"
    assert value == 1.95


def test_store_and_query(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    prices.store_price(conn, "XAUUSD", "2026-07-29T00:00:00Z", 3390.0)
    prices.store_price(conn, "XAUUSD", "2026-07-30T00:00:00Z", 3412.55)
    prices.store_price(conn, "XAUUSD", "2026-07-30T00:00:00Z", 9999.0)  # dup ts ignored
    assert prices.latest(conn, "XAUUSD")["value"] == 3412.55
    assert prices.value_at_or_before(conn, "XAUUSD", "2026-07-29T12:00:00Z") == 3390.0
    assert prices.value_at_or_before(conn, "XAUUSD", "2026-07-28T00:00:00Z") is None
