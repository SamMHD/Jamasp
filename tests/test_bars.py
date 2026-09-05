import json

import pytest

from jamasp.ingest.bars import Bar, parse_yahoo_bars, resample, resample_weekly


def _payload(timestamps, opens, highs, lows, closes):
    return json.dumps({"chart": {"result": [{
        "meta": {"symbol": "GC=F"},
        "timestamp": timestamps,
        "indicators": {"quote": [{
            "open": opens, "high": highs, "low": lows, "close": closes}]},
    }]}})


def test_parse_yahoo_bars_reads_open_time_and_ohlc():
    # 1767225600 = 2026-01-01T00:00:00Z
    text = _payload([1767225600, 1767229200], [10.0, 11.0], [12.0, 13.0],
                    [9.0, 10.5], [11.0, 12.5])
    bars = parse_yahoo_bars(text)
    assert bars == [
        Bar("2026-01-01T00:00:00Z", 10.0, 12.0, 9.0, 11.0),
        Bar("2026-01-01T01:00:00Z", 11.0, 13.0, 10.5, 12.5),
    ]


def test_parse_yahoo_bars_skips_bars_with_any_null_leg():
    # A bar missing any of O/H/L/C is not a bar: storing it with a fabricated
    # leg would corrupt ATR (which reads high and low) silently.
    text = _payload([1767225600, 1767229200, 1767232800],
                    [10.0, None, 12.0], [12.0, 13.0, 14.0],
                    [9.0, 10.5, 11.0], [11.0, 12.5, 13.5])
    bars = parse_yahoo_bars(text)
    assert [b.ts for b in bars] == ["2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z"]


def test_parse_yahoo_bars_returns_sorted_ascending():
    text = _payload([1767229200, 1767225600], [11.0, 10.0], [13.0, 12.0],
                    [10.5, 9.0], [12.5, 11.0])
    bars = parse_yahoo_bars(text)
    assert [b.ts for b in bars] == ["2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"]


def test_parse_yahoo_bars_raises_on_empty():
    with pytest.raises(ValueError):
        parse_yahoo_bars(_payload([], [], [], [], []))


def _h(hour, o, hi, lo, c):
    return Bar(f"2026-01-01T{hour:02d}:00:00Z", o, hi, lo, c)


def test_resample_4h_aggregates_open_extremes_close():
    # Four hourly bars inside one 4h group (00:00-03:59).
    bars = [_h(0, 10, 12, 9, 11), _h(1, 11, 15, 10, 12),
            _h(2, 12, 13, 7, 8), _h(3, 8, 9, 7.5, 8.5)]
    out = resample(bars, 4 * 3600)
    assert out == [Bar("2026-01-01T00:00:00Z", 10, 15, 7, 8.5)]


def test_resample_4h_groups_align_to_utc_midnight():
    # 03:00 and 04:00 must land in DIFFERENT groups: 14400 divides 86400, so
    # boundaries fall at 00/04/08/12/16/20 UTC and stay stable across runs.
    bars = [_h(3, 1, 1, 1, 1), _h(4, 2, 2, 2, 2)]
    out = resample(bars, 4 * 3600)
    assert [b.ts for b in out] == ["2026-01-01T00:00:00Z", "2026-01-01T04:00:00Z"]


def test_resample_leaves_a_partial_group_as_its_own_bar():
    # A group with fewer members than the interval is still a bar — the most
    # recent one always is, and dropping it would make the latest state a day
    # stale for no gain.
    bars = [_h(0, 10, 12, 9, 11), _h(1, 11, 15, 10, 12), _h(4, 20, 21, 19, 20)]
    out = resample(bars, 4 * 3600)
    assert out == [Bar("2026-01-01T00:00:00Z", 10, 15, 9, 12),
                   Bar("2026-01-01T04:00:00Z", 20, 21, 19, 20)]


def test_resample_weekly_groups_monday_to_sunday():
    # 2026-01-05 is a Monday; 2026-01-11 a Sunday; 2026-01-12 the next Monday.
    daily = [
        Bar("2026-01-05T00:00:00Z", 10, 12, 9, 11),
        Bar("2026-01-08T00:00:00Z", 11, 16, 8, 12),
        Bar("2026-01-11T00:00:00Z", 12, 13, 11, 12.5),
        Bar("2026-01-12T00:00:00Z", 20, 21, 19, 20),
    ]
    out = resample_weekly(daily)
    assert out == [
        Bar("2026-01-05T00:00:00Z", 10, 16, 8, 12.5),
        Bar("2026-01-12T00:00:00Z", 20, 21, 19, 20),
    ]


def test_resample_weekly_stamps_the_monday_even_when_monday_is_missing():
    # A holiday Monday must not shift the week's stamp to Tuesday — that would
    # make the same week land under two different keys across runs.
    daily = [Bar("2026-01-06T00:00:00Z", 10, 12, 9, 11),
             Bar("2026-01-07T00:00:00Z", 11, 13, 10, 12)]
    out = resample_weekly(daily)
    assert [b.ts for b in out] == ["2026-01-05T00:00:00Z"]


def test_resample_of_empty_is_empty():
    assert resample([], 4 * 3600) == []
    assert resample_weekly([]) == []


from jamasp import db
from jamasp.ingest.bars import SOURCE_YAHOO, backfill, read_bars, store_bars


def test_store_and_read_bars_round_trip(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    bars = [Bar("2026-01-02T00:00:00Z", 2, 3, 1, 2.5),
            Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)]
    assert store_bars(conn, "GC", "1d", bars, SOURCE_YAHOO) == 2
    assert read_bars(conn, "GC", "1d") == sorted(bars, key=lambda b: b.ts)


def test_store_bars_is_idempotent(tmp_path):
    # A re-run must fill gaps, not duplicate — a partial fetch has to be safe
    # to retry, and the daily timer re-runs this over overlapping history
    # every day for the rest of the deployment's life.
    conn = db.connect(tmp_path / "j.db")
    bars = [Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)]
    store_bars(conn, "GC", "1d", bars, SOURCE_YAHOO)
    store_bars(conn, "GC", "1d", bars, SOURCE_YAHOO)
    assert len(read_bars(conn, "GC", "1d")) == 1


def test_store_bars_overwrites_a_revised_bar(tmp_path):
    # Yahoo revises the most recent bar as it forms. The stored copy must
    # follow it rather than freeze at the first value seen.
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1d", [Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)], SOURCE_YAHOO)
    store_bars(conn, "GC", "1d", [Bar("2026-01-01T00:00:00Z", 1, 9, 0.5, 8.0)], SOURCE_YAHOO)
    assert read_bars(conn, "GC", "1d") == [Bar("2026-01-01T00:00:00Z", 1, 9, 0.5, 8.0)]


def test_store_bars_of_identical_rows_does_not_change_max_rowid(tmp_path):
    # `bars` is a rowid table and is git-tracked (state/jamasp.db, committed
    # every run per CLAUDE.md). INSERT OR REPLACE is delete+insert under the
    # hood: even byte-identical rows get fresh rowids, which rewrites every
    # touched b-tree page and turns a daily re-walk of unchanged history into
    # megabytes of new git objects for zero information. An upsert-in-place
    # (INSERT ... ON CONFLICT DO UPDATE) leaves rowids — and therefore pages
    # — untouched when nothing actually changed. This is the one observable
    # difference between the two forms, so it is what this test pins.
    conn = db.connect(tmp_path / "j.db")
    bars = [Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5),
            Bar("2026-01-02T00:00:00Z", 2, 3, 1.0, 2.5),
            Bar("2026-01-03T00:00:00Z", 3, 4, 1.5, 3.5)]
    store_bars(conn, "GC", "1d", bars, SOURCE_YAHOO)
    before = conn.execute("SELECT max(rowid) AS m FROM bars").fetchone()["m"]

    store_bars(conn, "GC", "1d", bars, SOURCE_YAHOO)  # byte-identical rows
    after = conn.execute("SELECT max(rowid) AS m FROM bars").fetchone()["m"]

    assert after == before
    assert read_bars(conn, "GC", "1d") == sorted(bars, key=lambda b: b.ts)


def test_store_bars_keeps_timeframes_separate(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    b = Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)
    store_bars(conn, "GC", "1h", [b], SOURCE_YAHOO)
    store_bars(conn, "GC", "1d", [b], SOURCE_YAHOO)
    assert len(read_bars(conn, "GC", "1h")) == 1
    assert len(read_bars(conn, "GC", "1d")) == 1


def _fake_fetch(hourly_text, daily_text):
    def fetch(url):
        return hourly_text if "interval=1h" in url else daily_text
    return fetch


def test_backfill_writes_all_four_timeframes(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    # 8 hourly bars starting 2026-01-05T00:00Z (a Monday) -> 2 four-hour bars.
    base = 1767571200  # 2026-01-05T00:00:00Z
    hourly = _payload([base + i * 3600 for i in range(8)],
                      [10.0 + i for i in range(8)], [20.0] * 8,
                      [1.0] * 8, [11.0 + i for i in range(8)])
    daily = _payload([base, base + 86400], [10.0, 20.0], [30.0, 40.0],
                     [1.0, 2.0], [15.0, 25.0])
    result = backfill(conn, "GC", fetch=_fake_fetch(hourly, daily))
    assert result.written == {"1h": 8, "4h": 2, "1d": 2, "1w": 1}
    assert result.failures == {}
    assert len(read_bars(conn, "GC", "1h")) == 8
    assert len(read_bars(conn, "GC", "4h")) == 2
    assert len(read_bars(conn, "GC", "1d")) == 2
    assert read_bars(conn, "GC", "1w") == [
        Bar("2026-01-05T00:00:00Z", 10.0, 40.0, 1.0, 25.0)]


def test_backfill_is_idempotent(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    base = 1767571200
    hourly = _payload([base + i * 3600 for i in range(8)],
                      [10.0 + i for i in range(8)], [20.0] * 8,
                      [1.0] * 8, [11.0 + i for i in range(8)])
    daily = _payload([base, base + 86400], [10.0, 20.0], [30.0, 40.0],
                     [1.0, 2.0], [15.0, 25.0])
    fetch = _fake_fetch(hourly, daily)
    backfill(conn, "GC", fetch=fetch)
    backfill(conn, "GC", fetch=fetch)
    counts = {tf: len(read_bars(conn, "GC", tf)) for tf in ("1h", "4h", "1d", "1w")}
    assert counts == {"1h": 8, "4h": 2, "1d": 2, "1w": 1}


def test_backfill_keeps_the_hourly_set_when_the_daily_fetch_fails(tmp_path):
    # A partial fetch must leave what it already got. Losing the 730-day
    # hourly pull because the daily call 404'd would make every retry pay for
    # it again. It reports the failed leg rather than raising: a partial
    # backfill is a normal outcome that must not stop the pipeline behind it.
    conn = db.connect(tmp_path / "j.db")
    base = 1767571200
    hourly = _payload([base + i * 3600 for i in range(4)],
                      [10.0] * 4, [20.0] * 4, [1.0] * 4, [11.0] * 4)

    def fetch(url):
        if "interval=1h" in url:
            return hourly
        raise RuntimeError("daily endpoint down")

    result = backfill(conn, "GC", fetch=fetch)
    assert len(read_bars(conn, "GC", "1h")) == 4
    assert set(result.written) == {"1h", "4h"}
    assert "daily endpoint down" in result.failures["1d"]


def test_backfill_still_stores_daily_when_the_hourly_fetch_fails(tmp_path):
    # The symmetric case of the test above, and the one that actually bit us:
    # Yahoo 429s the 730-day hourly pull while happily serving shallow
    # requests. Aborting on the hourly failure cost the daily and weekly bars
    # too, so `bars` stayed empty, `signals refresh` had nothing to compute
    # from and the ridge fits never saw a row — jamasp-weights.service failed
    # every day from 2026-08-24 without ever reaching its second ExecStart.
    conn = db.connect(tmp_path / "j.db")
    base = 1767571200
    daily = _payload([base, base + 86400], [10.0, 20.0], [30.0, 40.0],
                     [1.0, 2.0], [15.0, 25.0])

    def fetch(url):
        if "interval=1h" in url:
            raise RuntimeError("429 Too Many Requests")
        return daily

    result = backfill(conn, "GC", fetch=fetch)
    assert read_bars(conn, "GC", "1h") == []
    assert len(read_bars(conn, "GC", "1d")) == 2
    assert len(read_bars(conn, "GC", "1w")) == 1
    assert set(result.written) == {"1d", "1w"}
    assert "429" in result.failures["1h"]


def test_backfill_reports_every_leg_when_nothing_lands(tmp_path):
    # Total darkness is the one case that must still be loud: no timeframe
    # written means the caller has to exit non-zero.
    conn = db.connect(tmp_path / "j.db")

    def fetch(url):
        raise RuntimeError("429 Too Many Requests")

    result = backfill(conn, "GC", fetch=fetch)
    assert result.written == {}
    assert set(result.failures) == {"1h", "1d"}


from jamasp.ingest.bars import TIMEFRAME_SECONDS, close_ts


def test_close_ts_is_open_plus_one_period():
    assert close_ts("2026-01-05T00:00:00Z", "1h") == "2026-01-05T01:00:00Z"
    assert close_ts("2026-01-05T00:00:00Z", "4h") == "2026-01-05T04:00:00Z"
    assert close_ts("2026-01-05T00:00:00Z", "1d") == "2026-01-06T00:00:00Z"
    assert close_ts("2026-01-05T00:00:00Z", "1w") == "2026-01-12T00:00:00Z"


def test_timeframe_seconds_covers_every_stored_timeframe():
    assert set(TIMEFRAME_SECONDS) == {"1h", "4h", "1d", "1w"}


# --- Bitfinex fallback provider -------------------------------------------
#
# Yahoo refuses every deep-history request from the production egress (see
# docs/todo/012), so `bars` needs a second source or it stays empty forever.

from jamasp.ingest.bars import (
    SOURCE_BITFINEX,
    comex_sessions_only,
    parse_bitfinex_candles,
)

_MON = 1767571200      # 2026-01-05T00:00:00Z, a Monday
_SAT = _MON - 2 * 86400  # 2026-01-03, Saturday
_SUN = _MON - 86400      # 2026-01-04, Sunday


def _bfx(rows):
    """rows: (epoch_seconds, open, close, high, low) -> Bitfinex candle JSON."""
    return json.dumps([[ts * 1000, o, c, h, low, 1.0] for ts, o, c, h, low in rows])


def test_parse_bitfinex_candles_reads_the_open_close_high_low_column_order():
    # Bitfinex candles are [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME] — CLOSE comes
    # SECOND, not fourth. Reading them as OHLC swaps close with high and low
    # with close, which would feed ATR and every level signal a silently
    # wrong bar. This is the single most likely bug in this parser, so it is
    # pinned on its own.
    bars = parse_bitfinex_candles(_bfx([(_MON, 10.0, 11.0, 12.0, 9.0)]))
    assert bars == [Bar("2026-01-05T00:00:00Z", 10.0, 12.0, 9.0, 11.0)]


def test_parse_bitfinex_candles_sorts_ascending_from_a_newest_first_page():
    # We ask for sort=-1 (newest first) because that is the only way to get
    # the most recent 10,000 candles; every indicator downstream is
    # order-dependent, so the parser must restore ascending order.
    text = _bfx([(_MON + 86400, 2.0, 2.5, 3.0, 1.0), (_MON, 1.0, 1.5, 2.0, 0.5)])
    assert [b.ts for b in parse_bitfinex_candles(text)] == [
        "2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z"]


def test_parse_bitfinex_candles_drops_a_row_with_a_null_leg():
    text = json.dumps([[_MON * 1000, 10.0, None, 12.0, 9.0, 1.0],
                       [(_MON + 86400) * 1000, 1.0, 1.5, 2.0, 0.5, 1.0]])
    assert [b.ts for b in parse_bitfinex_candles(text)] == ["2026-01-06T00:00:00Z"]


def test_parse_bitfinex_candles_refuses_an_empty_page():
    with pytest.raises(ValueError):
        parse_bitfinex_candles("[]")


def test_comex_sessions_only_drops_saturday_and_the_closed_part_of_sunday():
    # XAUT trades 24/7; COMEX gold does not. Keeping weekend bars would make a
    # "200-day" SMA span ~143 trading days and let thin weekend wicks into
    # ATR. Globex reopens Sunday 22:00 UTC, so Sunday bars before that are
    # closed-market prints.
    bars = [
        Bar("2026-01-02T00:00:00Z", 1, 1, 1, 1),   # Friday   - kept
        Bar("2026-01-03T00:00:00Z", 1, 1, 1, 1),   # Saturday - dropped
        Bar("2026-01-04T00:00:00Z", 1, 1, 1, 1),   # Sunday 00:00 - dropped
        Bar("2026-01-04T22:00:00Z", 1, 1, 1, 1),   # Sunday 22:00 - kept
        Bar("2026-01-05T00:00:00Z", 1, 1, 1, 1),   # Monday   - kept
    ]
    assert [b.ts for b in comex_sessions_only(bars)] == [
        "2026-01-02T00:00:00Z", "2026-01-04T22:00:00Z", "2026-01-05T00:00:00Z"]


def _split_fetch(yahoo_hourly=None, yahoo_daily=None,
                 bfx_hourly=None, bfx_daily=None):
    """Route by URL, raising for whichever provider a test wants dark."""
    def fetch(url):
        if "bitfinex" in url:
            body = bfx_hourly if "trade:1h:" in url else bfx_daily
            who = "bitfinex"
        else:
            body = yahoo_hourly if "interval=1h" in url else yahoo_daily
            who = "yahoo"
        if body is None:
            raise RuntimeError(f"{who} endpoint refused")
        return body
    return fetch


def test_backfill_falls_back_to_bitfinex_when_yahoo_refuses_the_daily_leg(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    yahoo_hourly = _payload([_MON + i * 3600 for i in range(4)],
                            [10.0] * 4, [20.0] * 4, [1.0] * 4, [11.0] * 4)
    bfx_daily = _bfx([(_MON, 10.0, 15.0, 30.0, 1.0),
                      (_MON + 86400, 20.0, 25.0, 40.0, 2.0)])
    result = backfill(conn, "GC", fetch=_split_fetch(
        yahoo_hourly=yahoo_hourly, bfx_daily=bfx_daily))

    assert result.failures == {}
    assert read_bars(conn, "GC", "1d") == [
        Bar("2026-01-05T00:00:00Z", 10.0, 30.0, 1.0, 15.0),
        Bar("2026-01-06T00:00:00Z", 20.0, 40.0, 2.0, 25.0)]
    assert result.sources["1d"] == SOURCE_BITFINEX
    assert result.sources["1h"] == SOURCE_YAHOO


def test_backfill_falls_back_to_bitfinex_when_yahoo_refuses_the_hourly_leg(tmp_path):
    # The production case: Yahoo 429s range=730d&interval=1h AND
    # range=5y&interval=1d, so both legs land on the fallback.
    conn = db.connect(tmp_path / "j.db")
    bfx_hourly = _bfx([(_MON + i * 3600, 10.0, 11.0, 12.0, 9.0) for i in range(8)])
    bfx_daily = _bfx([(_MON, 10.0, 15.0, 30.0, 1.0)])
    result = backfill(conn, "GC", fetch=_split_fetch(
        bfx_hourly=bfx_hourly, bfx_daily=bfx_daily))

    assert result.failures == {}
    assert result.written == {"1h": 8, "4h": 2, "1d": 1, "1w": 1}
    assert result.sources == {"1h": SOURCE_BITFINEX, "4h": SOURCE_BITFINEX,
                              "1d": SOURCE_BITFINEX, "1w": SOURCE_BITFINEX}


def test_backfill_does_not_call_bitfinex_when_yahoo_serves(tmp_path):
    # Yahoo stays PRIMARY. GC=F is the instrument the desk actually trades;
    # the fallback is a spot proxy ~1.5% below it, so it must never be
    # preferred while the real thing is available.
    conn = db.connect(tmp_path / "j.db")
    called = []
    hourly = _payload([_MON + i * 3600 for i in range(4)],
                      [10.0] * 4, [20.0] * 4, [1.0] * 4, [11.0] * 4)
    daily = _payload([_MON], [10.0], [30.0], [1.0], [15.0])

    def fetch(url):
        called.append(url)
        return hourly if "interval=1h" in url else daily

    result = backfill(conn, "GC", fetch=fetch)
    assert not any("bitfinex" in u for u in called)
    assert set(result.sources.values()) == {SOURCE_YAHOO}


def test_backfill_reports_both_providers_when_a_leg_is_fully_dark(tmp_path):
    # Total darkness must name every provider that refused, so the journal
    # says whether this is a Yahoo problem or an everything problem.
    conn = db.connect(tmp_path / "j.db")
    result = backfill(conn, "GC", fetch=_split_fetch())
    assert result.written == {}
    assert set(result.failures) == {"1h", "1d"}
    for leg in ("1h", "1d"):
        assert "yahoo" in result.failures[leg]
        assert "bitfinex" in result.failures[leg]


def test_store_bars_evicts_rows_written_by_a_different_source(tmp_path):
    # The seam guard. Yahoo stamps GC=F daily bars at the session open;
    # Bitfinex stamps XAUT at 00:00 UTC, and the two series sit ~1.5% apart.
    # Letting both live in one timeframe would put duplicate days under
    # different keys and a 1.5% cliff in the middle of the series, which
    # every indicator would read as a real gap. One timeframe, one source.
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1d",
               [Bar("2026-01-05T00:00:00Z", 1, 2, 0.5, 1.5)], SOURCE_BITFINEX)
    store_bars(conn, "GC", "1d",
               [Bar("2026-01-05T04:00:00Z", 9, 9, 9, 9.0)], SOURCE_YAHOO)
    assert read_bars(conn, "GC", "1d") == [Bar("2026-01-05T04:00:00Z", 9, 9, 9, 9.0)]


def test_store_bars_does_not_evict_rows_from_the_same_source(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1d",
               [Bar("2026-01-05T00:00:00Z", 1, 2, 0.5, 1.5)], SOURCE_BITFINEX)
    store_bars(conn, "GC", "1d",
               [Bar("2026-01-06T00:00:00Z", 2, 3, 1.0, 2.5)], SOURCE_BITFINEX)
    assert len(read_bars(conn, "GC", "1d")) == 2
