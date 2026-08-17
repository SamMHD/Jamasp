from pathlib import Path

import pytest

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


def test_parse_yahoo_chart_json_uses_latest_non_null_close():
    symbol, ts, value = prices.parse_yahoo_chart_json(
        (FIXTURES / "yahoo_gc.json").read_text()
    )
    assert symbol == "GC"
    assert ts == "2026-07-30T22:51:51Z"
    assert value == 4167.7998046875


def test_parse_lbma_am_json_takes_latest_non_null_usd():
    symbol, ts, value = prices.parse_lbma_am_json((FIXTURES / "lbma_gold.json").read_text())
    assert symbol == "XAU_AM"
    assert ts == "2026-07-30T10:30:00Z"
    assert value == 4061.5


def test_parse_lbma_pm_json_takes_latest_non_null_usd():
    symbol, ts, value = prices.parse_lbma_pm_json((FIXTURES / "lbma_gold.json").read_text())
    assert symbol == "XAU_PM"
    assert ts == "2026-07-30T15:00:00Z"
    assert value == 4061.5


def test_parse_cftc_cot_json_net_noncommercial():
    symbol, ts, value = prices.parse_cftc_cot_json(
        (FIXTURES / "cftc_cot_gold.json").read_text()
    )
    assert symbol == "GC_NET_SPEC"
    assert ts == "2026-07-28T00:00:00Z"
    assert value == 302145 - 68210


def test_parse_cftc_cot_json_rejects_wrong_contract():
    # commodity_name=GOLD also matches MICRO GOLD; the parser must refuse
    # anything but the main COMEX contract rather than store wrong numbers.
    with pytest.raises(ValueError):
        prices.parse_cftc_cot_json((FIXTURES / "cftc_cot_micro.json").read_text())


def test_parse_sge_json_takes_latest_non_null():
    symbol, ts, value = prices.parse_sge_json(
        (FIXTURES / "sge_benchmark.json").read_text()
    )
    assert symbol == "SGE_AU_CNY_G"
    assert ts == "2026-07-30T00:00:00Z"
    assert value == 878.99


def test_fetch_price_symbol_override(monkeypatch):
    # Yahoo's meta.symbol is not stable for FX pairs (JPY=X came back as
    # "JPY" and "USDJPY" in consecutive live calls); a configured symbol
    # must win so one source can't split into two series.
    from jamasp.config import Source

    class FakeResp:
        text = (FIXTURES / "yahoo_gc.json").read_text()

    monkeypatch.setattr(prices, "get_with_fallback", lambda url, client: FakeResp())
    src = Source(
        name="x", type="price_api", url="https://x", interval_minutes=60,
        topic="prices", parser="yahoo_chart_json", symbol="USDJPY",
    )
    symbol, _, _ = prices.fetch_price(src, client=None)
    assert symbol == "USDJPY"


def test_parse_tradingview_scanner_json_maps_fields_and_drops_gauge():
    pairs = dict(
        prices.parse_tradingview_scanner_json(
            (FIXTURES / "tv_scanner_gc.json").read_text()
        )
    )
    assert set(pairs) == {"RSI14", "SMA50", "SMA200", "ATR14", "PIV_S1", "PIV_R1"}
    assert pairs["RSI14"] == pytest.approx(49.0847, abs=1e-3)
    assert pairs["PIV_R1"] == pytest.approx(4425.4, abs=1e-3)
    # Recommend.All (buy/sell gauge) and close must never become series


def test_parse_tradingview_scanner_json_skips_nulls():
    pairs = prices.parse_tradingview_scanner_json('{"RSI": null, "ATR": 5.0}')
    assert pairs == [("ATR14", 5.0)]
    with pytest.raises(ValueError):
        prices.parse_tradingview_scanner_json('{"RSI": null}')


def test_fetch_technicals_prefixes_symbols_and_stamps_fetch_time(monkeypatch):
    from jamasp.config import Source

    class FakeResp:
        text = (FIXTURES / "tv_scanner_gc.json").read_text()

    monkeypatch.setattr(prices, "get_with_fallback", lambda url, client: FakeResp())
    src = Source(
        name="tv", type="technicals_api", url="https://x", interval_minutes=360,
        topic="prices", parser="tradingview_scanner_json", symbol="GC",
    )
    rows = prices.fetch_technicals(src, client=None)
    assert {s for s, _, _ in rows} == {
        "GC_RSI14", "GC_SMA50", "GC_SMA200", "GC_ATR14", "GC_PIV_S1", "GC_PIV_R1"
    }
    # one shared fetch-time stamp in the canonical format
    stamps = {ts for _, ts, _ in rows}
    assert len(stamps) == 1
    from datetime import datetime

    datetime.strptime(stamps.pop(), "%Y-%m-%dT%H:%M:%SZ")


def test_fetch_technicals_requires_symbol_prefix(monkeypatch):
    from jamasp.config import Source

    src = Source(
        name="tv", type="technicals_api", url="https://x", interval_minutes=360,
        topic="prices", parser="tradingview_scanner_json",
    )
    with pytest.raises(ValueError):
        prices.fetch_technicals(src, client=None)


def test_store_and_query(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    prices.store_price(conn, "XAUUSD", "2026-07-29T00:00:00Z", 3390.0)
    prices.store_price(conn, "XAUUSD", "2026-07-30T00:00:00Z", 3412.55)
    prices.store_price(conn, "XAUUSD", "2026-07-30T00:00:00Z", 9999.0)  # dup ts ignored
    assert prices.latest(conn, "XAUUSD")["value"] == 3412.55
    assert prices.value_at_or_before(conn, "XAUUSD", "2026-07-29T12:00:00Z") == 3390.0
    assert prices.value_at_or_before(conn, "XAUUSD", "2026-07-28T00:00:00Z") is None


def test_window_extremes_finds_intraday_touch(tmp_path):
    # The e3a35539 failure: gold tagged 4501.8 at 00:35Z in the Asia
    # overnight and settled back. Endpoint prices can't see that touch —
    # a MAX/MIN over the window can.
    conn = db.connect(tmp_path / "j.db")
    prices.store_price(conn, "GC", "2026-08-12T20:00:00Z", 4468.0)
    prices.store_price(conn, "GC", "2026-08-13T00:35:00Z", 4501.8)
    prices.store_price(conn, "GC", "2026-08-13T08:00:00Z", 4471.0)
    ext = prices.window_extremes(conn, "GC", "2026-08-12T18:00:00Z", "2026-08-13T12:00:00Z")
    assert ext["high"] == 4501.8
    assert ext["high_ts"] == "2026-08-13T00:35:00Z"
    assert ext["low"] == 4468.0
    assert ext["low_ts"] == "2026-08-12T20:00:00Z"


def test_window_extremes_respects_bounds(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    prices.store_price(conn, "GC", "2026-08-11T00:00:00Z", 4600.0)  # before window
    prices.store_price(conn, "GC", "2026-08-12T20:00:00Z", 4468.0)
    prices.store_price(conn, "GC", "2026-08-14T00:00:00Z", 4300.0)  # after window
    ext = prices.window_extremes(conn, "GC", "2026-08-12T00:00:00Z", "2026-08-13T00:00:00Z")
    assert ext["high"] == 4468.0 and ext["low"] == 4468.0


def test_window_extremes_empty_window(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    ext = prices.window_extremes(conn, "GC", "2026-08-12T00:00:00Z", "2026-08-13T00:00:00Z")
    assert ext == {"high": None, "high_ts": None, "low": None, "low_ts": None}
