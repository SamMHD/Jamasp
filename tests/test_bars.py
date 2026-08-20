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
