from datetime import datetime, timedelta, timezone

import pytest

from jamasp import indicators as ind
from jamasp.ingest.bars import TS_FMT, Bar


def _ts(i, seconds=86400, start="2026-01-01T00:00:00Z"):
    """Timestamp arithmetic, not f-string day arithmetic.

    `f"2026-01-{i + 1:02d}"` produces "2026-01-40" past 31 bars — a string no
    date parser accepts. Nothing in this module parses a timestamp, so it
    would not fail here; it would fail in whichever later test first does.
    """
    base = datetime.strptime(start, TS_FMT).replace(tzinfo=timezone.utc)
    return (base + timedelta(seconds=i * seconds)).strftime(TS_FMT)


def _bars(closes, highs=None, lows=None):
    highs = highs if highs is not None else [c + 1 for c in closes]
    lows = lows if lows is not None else [c - 1 for c in closes]
    return [
        Bar(_ts(i), c, h, low, c)
        for i, (c, h, low) in enumerate(zip(closes, highs, lows))
    ]


# ---- moving averages -------------------------------------------------------

def test_sma_of_a_constant_series_is_that_constant():
    out = ind.sma([5.0] * 10, 3)
    assert out[:2] == [None, None]      # warm-up
    assert out[2:] == [5.0] * 8


def test_sma_window_is_exactly_n_values():
    # SMA3 of 1..5 at index 4 is mean(3,4,5) = 4.
    assert ind.sma([1.0, 2.0, 3.0, 4.0, 5.0], 3)[4] == pytest.approx(4.0)


def test_ema_of_a_constant_series_is_that_constant():
    out = ind.ema([7.0] * 20, 5)
    assert out[4:] == pytest.approx([7.0] * 16)


def test_stdev_of_a_constant_series_is_zero():
    assert ind.stdev([3.0] * 10, 4)[9] == pytest.approx(0.0)


# ---- RSI -------------------------------------------------------------------

def test_rsi_of_a_monotonic_rise_is_one_hundred():
    # Average loss is exactly zero, so RS is unbounded and RSI pins at 100.
    out = ind.rsi(_bars([float(i) for i in range(1, 40)]), 14)
    assert out[-1] == pytest.approx(100.0)


def test_rsi_of_a_monotonic_fall_is_zero():
    out = ind.rsi(_bars([float(i) for i in range(40, 1, -1)]), 14)
    assert out[-1] == pytest.approx(0.0)


def test_rsi_of_equal_alternating_moves_sits_near_fifty():
    # Wilder smoothing does not settle exactly on 50 for an alternating
    # series: the smoothed gain and loss swap which one absorbed the latest
    # move, so the reading oscillates in a narrow band around 50 forever.
    # A band is the true expectation here; asserting exactly 50.0 would be
    # asserting something the algorithm does not do.
    closes = [100.0 + (1.0 if i % 2 else 0.0) for i in range(60)]
    assert 40.0 < ind.rsi(_bars(closes), 14)[-1] < 60.0


def test_rsi_of_a_flat_series_is_fifty():
    # No gains AND no losses. 100 would be wrong (that is the unbroken-rise
    # answer) and a ZeroDivisionError would be worse: a flat tape has no
    # momentum either way, which is exactly what 50 means.
    assert ind.rsi(_bars([100.0] * 40), 14)[-1] == pytest.approx(50.0)


def test_rsi_warm_up_is_none():
    out = ind.rsi(_bars([float(i) for i in range(1, 20)]), 14)
    assert out[13] is None and out[14] is not None


# ---- ATR -------------------------------------------------------------------

def test_atr_of_constant_range_bars_is_that_range():
    # Every bar spans exactly 4, and each close sits mid-range so the
    # gap terms in true range never exceed high-low.
    bars = [Bar(_ts(i), 100, 102, 98, 100) for i in range(40)]
    assert ind.atr(bars, 14)[-1] == pytest.approx(4.0)


def test_atr_counts_a_gap_as_true_range():
    # Bar 2 spans 1 (110-109) but gaps 10 above bar 1's close (110-100): true
    # range is max(high-low, |high-prevClose|, |low-prevClose|)
    # = max(1, 10, 9) = 10, not 1.
    bars = [Bar("2026-01-01T00:00:00Z", 100, 100, 99, 100),
            Bar("2026-01-02T00:00:00Z", 110, 110, 109, 110)]
    assert ind.atr(bars, 1)[-1] == pytest.approx(10.0)


# ---- MACD ------------------------------------------------------------------

def test_macd_of_a_constant_series_is_zero():
    bars = _bars([50.0] * 80)
    line, sig = ind.macd(bars)
    assert line[-1] == pytest.approx(0.0)
    assert sig[-1] == pytest.approx(0.0)


def test_macd_is_positive_in_an_uptrend():
    # A perpetual constant-slope ramp will NOT do here: for a linear input the
    # EMA-of-linear-input identity makes the MACD line hit its exact
    # steady-state constant from the moment it exists (seed included), so a
    # signal line seeded on already-constant values equals the line with no
    # transient at all -- line > sig never holds beyond float noise for a
    # pure ramp, verified by sweeping series length against this module's
    # macd(). A flat run followed by a rise is a genuine "uptrend begins"
    # transient: the fast EMA reacts to the recent rise before the slower
    # signal (an EMA of the MACD line itself) catches up.
    closes = [50.0] * 60 + [50.0 + i for i in range(1, 41)]
    line, sig = ind.macd(_bars(closes))
    assert line[-1] > 0 and line[-1] > sig[-1]


# ---- Stochastic and Williams %R --------------------------------------------

def test_stoch_k_is_one_hundred_at_the_window_high():
    # Final close equals the window's highest high.
    closes = [10.0] * 19 + [11.0]
    bars = _bars(closes, highs=[11.0] * 20, lows=[9.0] * 20)
    k, _ = ind.stochastic(bars, k=14, d=3)
    assert k[-1] == pytest.approx(100.0)


def test_stoch_k_is_zero_at_the_window_low():
    closes = [10.0] * 19 + [9.0]
    bars = _bars(closes, highs=[11.0] * 20, lows=[9.0] * 20)
    k, _ = ind.stochastic(bars, k=14, d=3)
    assert k[-1] == pytest.approx(0.0)


def test_williams_r_is_zero_at_the_high_and_minus_hundred_at_the_low():
    high_close = _bars([10.0] * 19 + [11.0], highs=[11.0] * 20, lows=[9.0] * 20)
    low_close = _bars([10.0] * 19 + [9.0], highs=[11.0] * 20, lows=[9.0] * 20)
    assert ind.williams_r(high_close, 14)[-1] == pytest.approx(0.0)
    assert ind.williams_r(low_close, 14)[-1] == pytest.approx(-100.0)


# ---- Bollinger -------------------------------------------------------------

def test_bollinger_bands_collapse_onto_a_constant_series():
    upper, lower = ind.bollinger(_bars([25.0] * 40), n=20, k=2.0)
    assert upper[-1] == pytest.approx(25.0)
    assert lower[-1] == pytest.approx(25.0)


def test_bollinger_bands_are_symmetric_about_the_mean():
    closes = [100.0 + (i % 5) for i in range(40)]
    upper, lower = ind.bollinger(_bars(closes), n=20, k=2.0)
    mid = ind.sma(closes, 20)[-1]
    assert (upper[-1] + lower[-1]) / 2 == pytest.approx(mid)


# ---- ADX -------------------------------------------------------------------

def test_adx_is_high_in_a_clean_trend():
    # A pure staircase has +DI dominant every bar, so ADX saturates high.
    out = ind.adx(_bars([float(i) for i in range(1, 80)]), 14)
    assert out[-1] > 40


def test_adx_is_low_in_a_flat_market():
    bars = [Bar(_ts(i), 100, 101, 99, 100) for i in range(80)]
    out = ind.adx(bars, 14)
    assert out[-1] is not None and out[-1] < 25


# ---- Fibonacci and pivots --------------------------------------------------

def test_fib_levels_are_retracements_of_the_lookback_range():
    # Range 100..200 -> 0.618 retracement at 200 - 0.618*100 = 138.2,
    # midpoint at 150.
    closes = [100.0 + i for i in range(101)]   # 100 .. 200
    f618, f50 = ind.fib_levels(_bars(closes, highs=closes, lows=closes),
                               lookback=101)
    assert f618[-1] == pytest.approx(138.2)
    assert f50[-1] == pytest.approx(150.0)


def test_pivots_come_from_the_PREVIOUS_bar():
    # P = (110 + 90 + 100)/3 = 100; R1 = 2P - L = 110; S1 = 2P - H = 90.
    # Reading the CURRENT bar would be lookahead: a pivot is a level you
    # trade the next session against, not one you knew intrabar.
    bars = [Bar("2026-01-01T00:00:00Z", 100, 110, 90, 100),
            Bar("2026-01-02T00:00:00Z", 100, 500, 1, 100)]
    r1, s1 = ind.pivots(bars)
    assert r1[0] is None and s1[0] is None
    assert r1[1] == pytest.approx(110.0)
    assert s1[1] == pytest.approx(90.0)


# ---- compute_all -----------------------------------------------------------

def test_compute_all_returns_one_dict_per_bar_with_every_key():
    bars = _bars([100.0 + (i % 7) for i in range(260)])
    rows = ind.compute_all(bars)
    assert len(rows) == len(bars)
    for row in rows:
        assert set(row) == set(ind.INDICATOR_KEYS)
    assert rows[-1]["sma200"] is not None
    assert rows[-1]["close"] == pytest.approx(bars[-1].close)


def test_compute_all_leaves_warm_up_keys_none_rather_than_guessing():
    rows = ind.compute_all(_bars([100.0] * 5))
    assert rows[-1]["sma200"] is None
    assert rows[-1]["close"] is not None


def test_compute_all_of_an_empty_series_is_empty():
    assert ind.compute_all([]) == []
