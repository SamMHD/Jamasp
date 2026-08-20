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
from jamasp.ingest.bars import backfill, read_bars, store_bars


def test_store_and_read_bars_round_trip(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    bars = [Bar("2026-01-02T00:00:00Z", 2, 3, 1, 2.5),
            Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)]
    assert store_bars(conn, "GC", "1d", bars) == 2
    assert read_bars(conn, "GC", "1d") == sorted(bars, key=lambda b: b.ts)


def test_store_bars_is_idempotent(tmp_path):
    # A re-run must fill gaps, not duplicate — a partial fetch has to be safe
    # to retry, and the daily timer re-runs this over overlapping history
    # every day for the rest of the deployment's life.
    conn = db.connect(tmp_path / "j.db")
    bars = [Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)]
    store_bars(conn, "GC", "1d", bars)
    store_bars(conn, "GC", "1d", bars)
    assert len(read_bars(conn, "GC", "1d")) == 1


def test_store_bars_overwrites_a_revised_bar(tmp_path):
    # Yahoo revises the most recent bar as it forms. The stored copy must
    # follow it rather than freeze at the first value seen.
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1d", [Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)])
    store_bars(conn, "GC", "1d", [Bar("2026-01-01T00:00:00Z", 1, 9, 0.5, 8.0)])
    assert read_bars(conn, "GC", "1d") == [Bar("2026-01-01T00:00:00Z", 1, 9, 0.5, 8.0)]


def test_store_bars_keeps_timeframes_separate(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    b = Bar("2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5)
    store_bars(conn, "GC", "1h", [b])
    store_bars(conn, "GC", "1d", [b])
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
    written = backfill(conn, "GC", fetch=_fake_fetch(hourly, daily))
    assert written == {"1h": 8, "4h": 2, "1d": 2, "1w": 1}
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
    # it again.
    conn = db.connect(tmp_path / "j.db")
    base = 1767571200
    hourly = _payload([base + i * 3600 for i in range(4)],
                      [10.0] * 4, [20.0] * 4, [1.0] * 4, [11.0] * 4)

    def fetch(url):
        if "interval=1h" in url:
            return hourly
        raise RuntimeError("daily endpoint down")

    with pytest.raises(RuntimeError):
        backfill(conn, "GC", fetch=fetch)
    assert len(read_bars(conn, "GC", "1h")) == 4


from jamasp.ingest.bars import TIMEFRAME_SECONDS, close_ts


def test_close_ts_is_open_plus_one_period():
    assert close_ts("2026-01-05T00:00:00Z", "1h") == "2026-01-05T01:00:00Z"
    assert close_ts("2026-01-05T00:00:00Z", "4h") == "2026-01-05T04:00:00Z"
    assert close_ts("2026-01-05T00:00:00Z", "1d") == "2026-01-06T00:00:00Z"
    assert close_ts("2026-01-05T00:00:00Z", "1w") == "2026-01-12T00:00:00Z"


def test_timeframe_seconds_covers_every_stored_timeframe():
    assert set(TIMEFRAME_SECONDS) == {"1h", "4h", "1d", "1w"}
