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
    assert set(pairs) == {
        "RSI14", "SMA50", "SMA200", "ATR14", "PIV_S1", "PIV_R1", "CLOSE",
    }
    assert pairs["RSI14"] == pytest.approx(49.0847, abs=1e-3)
    assert pairs["PIV_R1"] == pytest.approx(4425.4, abs=1e-3)
    # Recommend.All (buy/sell gauge) must never become a series


def test_parse_tradingview_scanner_json_skips_nulls_and_raises_when_empty():
    # Renamed from test_parse_tradingview_scanner_json_skips_nulls (Task 6):
    # the brief adds a new test of that same name that covers the
    # multi-timeframe null-skipping case, so this one — which additionally
    # covers the list-of-tuples return shape and the all-fields-null
    # ValueError — needed a distinct name to keep running instead of being
    # silently shadowed.
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
        "GC_RSI14", "GC_SMA50", "GC_SMA200", "GC_ATR14", "GC_PIV_S1", "GC_PIV_R1",
        "GC_CLOSE",
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


def test_tv_field_suffixes_cover_three_timeframes():
    m = prices.TV_FIELD_SUFFIXES
    assert m["RSI"] == "RSI14"
    assert m["RSI|1W"] == "RSI14_1W"
    assert m["RSI|240"] == "RSI14_4H"
    assert m["MACD.macd"] == "MACD"
    assert m["Pivot.M.Fibonacci.S1"] == "FIB_S1"


def test_tv_field_suffixes_keep_the_existing_series_names():
    # These four series already hold months of history in the live database.
    # Renaming any of them would orphan it and silently restart the series.
    m = prices.TV_FIELD_SUFFIXES
    assert m["SMA50"] == "SMA50"
    assert m["SMA200"] == "SMA200"
    assert m["ATR"] == "ATR14"
    assert m["Pivot.M.Classic.S1"] == "PIV_S1"
    assert m["Pivot.M.Classic.R1"] == "PIV_R1"


def test_tv_field_suffixes_exclude_the_aggregate_gauges():
    # config/sources.yaml:324 — technicals annotate the macro read, they must
    # not originate calls. Neither market map produces an aggregate verdict.
    keys = set(prices.TV_FIELD_SUFFIXES)
    assert not any(k.startswith("Recommend") for k in keys)


def test_parse_tradingview_scanner_json_reads_multi_timeframe_fields():
    payload = ('{"RSI": 41.2, "RSI|1W": 55.0, "RSI|240": 38.5,'
               ' "MACD.macd": 1.5, "close": 4312.4}')
    out = dict(prices.parse_tradingview_scanner_json(payload))
    assert out["RSI14"] == 41.2
    assert out["RSI14_1W"] == 55.0
    assert out["RSI14_4H"] == 38.5
    assert out["MACD"] == 1.5
    assert out["CLOSE"] == 4312.4


def test_parse_tradingview_scanner_json_skips_nulls():
    # Fields come back null when a timeframe's bar has not closed; storing
    # them as 0.0 would print a fake oversold RSI.
    out = dict(prices.parse_tradingview_scanner_json(
        '{"RSI": 41.2, "RSI|240": null}'))
    assert out == {"RSI14": 41.2}


def test_configured_tv_url_requests_every_mapped_field():
    # The field list lives in the URL and the name mapping lives in code;
    # nothing else stops them drifting apart. A raw substring check is NOT
    # enough here: every base field name (e.g. "RSI") is itself a prefix of
    # its own suffixed siblings ("RSI|1W", "RSI|240"), so a URL that dropped
    # the bare "RSI" entirely while keeping the suffixed forms would still
    # contain the substring "RSI" and pass a naive `in` check. Parse the
    # actual `fields=` query value and compare as an exact set instead.
    from urllib.parse import parse_qs, urlsplit

    from jamasp import config

    src = next(s for s in config.load_sources()
               if s.name == "tv_gc_technicals")
    query = parse_qs(urlsplit(src.url).query)
    requested = set(query["fields"][0].split(","))
    assert requested == set(prices.TV_FIELD_SUFFIXES)
