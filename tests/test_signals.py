from datetime import datetime, timedelta, timezone

import pytest

from jamasp import signals
from jamasp.config import load_weights, signal_specs
from jamasp.ingest.bars import TS_FMT, Bar, close_ts


def test_clamp_bounds_to_the_unit_interval():
    assert signals.clamp(5.0) == 1.0
    assert signals.clamp(-5.0) == -1.0
    assert signals.clamp(0.25) == 0.25


# ---- the sign convention, pinned classifier by classifier -------------------
# Positive is bullish for gold. A single inverted classifier hands the fit a
# coefficient with the wrong sign and the map a tile with the wrong colour,
# and neither looks broken. These are the tests that would catch it.

def test_rsi_oversold_is_bullish_and_overbought_is_bearish():
    assert signals.classify("rsi14", {"rsi14": 30.0}) == pytest.approx(1.0)
    assert signals.classify("rsi14", {"rsi14": 70.0}) == pytest.approx(-1.0)
    assert signals.classify("rsi14", {"rsi14": 50.0}) == pytest.approx(0.0)


def test_stoch_oversold_is_bullish():
    assert signals.classify("stoch", {"stoch_k": 20.0}) == pytest.approx(1.0)
    assert signals.classify("stoch", {"stoch_k": 80.0}) == pytest.approx(-1.0)
    assert signals.classify("stoch", {"stoch_k": 50.0}) == pytest.approx(0.0)


def test_willr_oversold_is_bullish():
    # W%R runs -100 (at the low) to 0 (at the high); its midpoint is -50.
    assert signals.classify("willr", {"willr": -80.0}) == pytest.approx(1.0)
    assert signals.classify("willr", {"willr": -20.0}) == pytest.approx(-1.0)
    assert signals.classify("willr", {"willr": -50.0}) == pytest.approx(0.0)


def test_macd_above_signal_is_bullish():
    ctx = {"macd": 5.0, "macd_signal": 0.0, "atr14": 10.0}
    assert signals.classify("macd", ctx) == pytest.approx(1.0)
    assert signals.classify("macd", {**ctx, "macd": -5.0}) == pytest.approx(-1.0)
    assert signals.classify("macd", {**ctx, "macd": 0.0}) == pytest.approx(0.0)


def test_adx_is_signed_by_the_regime_it_measures():
    # Strength alone says nothing about direction, so a strong trend below the
    # 50DMA must read bearish, not "strong".
    up = {"adx": 40.0, "close": 110.0, "sma50": 100.0}
    down = {"adx": 40.0, "close": 90.0, "sma50": 100.0}
    assert signals.classify("adx", up) == pytest.approx(1.0)
    assert signals.classify("adx", down) == pytest.approx(-1.0)


def test_close_above_the_moving_averages_is_bullish():
    assert signals.classify(
        "sma50", {"close": 110.0, "sma50": 100.0, "atr14": 10.0}) == pytest.approx(1.0)
    assert signals.classify(
        "sma50", {"close": 90.0, "sma50": 100.0, "atr14": 10.0}) == pytest.approx(-1.0)
    assert signals.classify(
        "sma200", {"close": 120.0, "sma200": 100.0, "atr14": 10.0}) == pytest.approx(1.0)


def test_bollinger_reads_mean_reversion_not_momentum():
    # At the lower band is BULLISH. This is the one classifier whose sign a
    # reader is most likely to assume backwards.
    low = {"close": 90.0, "bb_upper": 110.0, "bb_lower": 90.0}
    high = {"close": 110.0, "bb_upper": 110.0, "bb_lower": 90.0}
    mid = {"close": 100.0, "bb_upper": 110.0, "bb_lower": 90.0}
    assert signals.classify("bollinger", low) == pytest.approx(1.0)
    assert signals.classify("bollinger", high) == pytest.approx(-1.0)
    assert signals.classify("bollinger", mid) == pytest.approx(0.0)


def test_volatility_expansion_reads_bullish():
    assert signals.classify(
        "atr14", {"atr14": 15.0, "atr14_avg": 10.0}) == pytest.approx(1.0)
    assert signals.classify(
        "atr14", {"atr14": 10.0, "atr14_avg": 10.0}) == pytest.approx(0.0)


def test_close_above_the_fib_levels_is_bullish():
    assert signals.classify(
        "fib618", {"close": 148.2, "fib618": 138.2, "atr14": 10.0}) == pytest.approx(1.0)
    assert signals.classify(
        "fib50", {"close": 140.0, "fib50": 150.0, "atr14": 10.0}) == pytest.approx(-1.0)


def test_pivot_places_the_close_within_the_r1_s1_band():
    band = {"pivot_r1": 110.0, "pivot_s1": 90.0}
    assert signals.classify("pivot", {**band, "close": 110.0}) == pytest.approx(1.0)
    assert signals.classify("pivot", {**band, "close": 90.0}) == pytest.approx(-1.0)
    assert signals.classify("pivot", {**band, "close": 100.0}) == pytest.approx(0.0)


def test_external_series_classifiers():
    assert signals.classify(
        "gvz", {"value": 15.0, "value_avg": 10.0}) == pytest.approx(1.0)
    assert signals.classify(
        "net_spec", {"value": 30.0, "value_avg": 10.0, "value_sd": 10.0}
    ) == pytest.approx(1.0)


# ---- degenerate inputs ------------------------------------------------------

def test_classify_returns_none_when_an_input_is_missing():
    assert signals.classify("sma50", {"close": 100.0, "sma50": 100.0}) is None
    assert signals.classify("rsi14", {}) is None


def test_classify_returns_none_rather_than_dividing_by_zero():
    assert signals.classify(
        "sma50", {"close": 100.0, "sma50": 90.0, "atr14": 0.0}) is None
    assert signals.classify(
        "bollinger", {"close": 100.0, "bb_upper": 100.0, "bb_lower": 100.0}) is None
    assert signals.classify(
        "pivot", {"close": 100.0, "pivot_r1": 100.0, "pivot_s1": 100.0}) is None


def test_classify_raises_on_an_unknown_signal_name():
    # A typo in config/weights.yaml must fail loudly at fit time, not produce
    # a silently absent feature column.
    with pytest.raises(KeyError):
        signals.classify("vibes", {})


def test_every_configured_signal_has_a_classifier():
    names = {s.name for s in signal_specs(load_weights())}
    assert names <= set(signals.CLASSIFIERS)


def test_every_classifier_output_is_within_the_unit_interval():
    # Extreme, absurd inputs must still clamp: an unclamped state would blow
    # up a whole feature column's scale in the fit.
    extreme = {
        "rsi14": 0.0, "stoch_k": 100.0, "willr": -100.0, "macd": 1e6,
        "macd_signal": -1e6, "atr14": 1e-3, "atr14_avg": 1e-6, "adx": 100.0,
        "close": 1e6, "sma50": 1.0, "sma200": 1.0, "bb_upper": 2.0,
        "bb_lower": 1.0, "fib618": 1.0, "fib50": 1.0, "pivot_r1": 2.0,
        "pivot_s1": 1.0, "value": 1e9, "value_avg": 1.0, "value_sd": 1e-9,
    }
    for name in signals.CLASSIFIERS:
        v = signals.classify(name, extreme)
        assert v is None or -1.0 <= v <= 1.0, name


# ---- history ----------------------------------------------------------------

def _day(i, start="2026-01-01T00:00:00Z"):
    """Date arithmetic, not f-string day arithmetic.

    `f"2026-01-{i + 1:02d}"` yields "2026-01-40" past 31 bars, and
    jamasp.ingest.bars.close_ts parses these strings — so the shortcut fails
    loudly here rather than quietly.
    """
    base = datetime.strptime(start, TS_FMT).replace(tzinfo=timezone.utc)
    return (base + timedelta(days=i)).strftime(TS_FMT)


def _rising(n):
    return [Bar(_day(i), 100.0 + i, 101.0 + i, 99.0 + i, 100.0 + i)
            for i in range(n)]


def test_bar_states_skips_warm_up_and_stamps_the_bar_CLOSE():
    out = signals.bar_states("rsi14", _rising(40), "1d")
    assert out, "expected states once RSI has warmed up"
    first_ts, _ = out[0]
    # 40 rising daily bars starting 2026-01-01: RSI warms at bar 15
    # (index 14, 2026-01-15), whose close is the NEXT midnight. A state
    # stamped with the open would be readable a full day before it existed.
    assert first_ts == "2026-01-16T00:00:00Z"
    assert all(-1.0 <= v <= 1.0 for _, v in out)


def test_bar_states_of_a_rising_series_is_bearish_for_rsi():
    # Unbroken rise -> RSI 100 -> the mean-reversion read is maximally bearish.
    out = signals.bar_states("rsi14", _rising(60), "1d")
    assert out[-1][1] == pytest.approx(-1.0)


def _flat_tr(n):
    """`n` bars with a constant true range of 2.0 and a flat close.

    high=close+1, low=close-1, close never moves: high-low=2.0 every bar,
    and since the close is unchanged the high/low-vs-prior-close legs of the
    true range (1.0 each) never exceed it, so TR is exactly 2.0 throughout
    -- including bar 0, whose TR is just high-low with no prior close to
    compare against.
    """
    return [Bar(_day(i), 100.0, 101.0, 99.0, 100.0) for i in range(n)]


def test_bar_states_atr_avg_ignores_the_pre_warm_up_none_prefix():
    # ATR's own 14-bar warm-up leaves atr14 as None for bars 0..12; it is
    # real (and, on this constant-TR series, exactly 2.0) from bar 13 on.
    # atr14_avg is a 50-bar rolling average OF atr14 -- padding those 13
    # leading Nones with 0.0 before averaging would treat "not yet
    # measured" as "measured at zero volatility" and drag the average down
    # for the next 49 bars, well past where atr14 itself is genuinely real.
    #
    # Averaging over the real atr14 values only (offset re-mapped, as
    # indicators.macd/stochastic already do for their own derivatives)
    # means atr14_avg has no real reading until 50 real atr14 values exist:
    # offset 13 + a 50-wide window = bar index 62. Bar 49 sits inside that
    # gap -- real enough for atr14 itself, too early for its honest average
    # -- and is exactly where the zero-padded version fabricates a ~+0.70
    # "volatility expansion" read on a series whose volatility never moved.
    bars = _flat_tr(70)
    out = dict(signals.bar_states("atr14", bars, "1d"))

    ts_49 = close_ts(bars[49].ts, "1d")
    assert ts_49 not in out, (
        "atr14_avg is not yet a real 50-bar average of real atr14 values at "
        f"bar 49; got a state of {out.get(ts_49)} instead of no reading"
    )

    # Once the average window is genuinely full of real atr14 values (bar
    # 62 on), a constant-TR series must read as no expansion at all.
    ts_65 = close_ts(bars[65].ts, "1d")
    assert out[ts_65] == pytest.approx(0.0)


from jamasp import db
from jamasp.ingest.bars import store_bars


def test_refresh_writes_one_row_per_readable_column(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    for tf in ("1d", "4h", "1w"):
        store_bars(conn, "GC", tf, _rising(300))
    n = signals.refresh(conn, load_weights(), "GC")
    keys = {r["key"] for r in conn.execute("SELECT key FROM signal_states")}
    assert n == len(keys)
    # 12 bar signals x 3 timeframes; GVZ and net spec have no prices rows here.
    assert "rsi14@1d" in keys and "sma200@4h" in keys
    assert not any(k.startswith("gvz") or k.startswith("net_spec") for k in keys)


def test_refresh_is_idempotent(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    for tf in ("1d", "4h", "1w"):
        store_bars(conn, "GC", tf, _rising(300))
    signals.refresh(conn, load_weights(), "GC")
    before = conn.execute("SELECT COUNT(*) c FROM signal_states").fetchone()["c"]
    signals.refresh(conn, load_weights(), "GC")
    after = conn.execute("SELECT COUNT(*) c FROM signal_states").fetchone()["c"]
    assert before == after


def test_refresh_with_no_bars_writes_nothing_rather_than_raising(tmp_path):
    # A host that has not run the backfill yet must not take the timer down.
    conn = db.connect(tmp_path / "j.db")
    assert signals.refresh(conn, load_weights(), "GC") == 0


# ---- TradingView fallback -------------------------------------------------


def _seed_tv(conn, ts="2026-08-25T04:31:05Z", **overrides):
    """Seed the daily TradingView series `jamasp ingest` already stores."""
    values = {
        "CLOSE": 4700.0, "RSI14": 30.0, "STOCH_K": 20.0, "STOCH_D": 25.0,
        "WILLR": -80.0, "MACD": 5.0, "MACD_SIG": 0.0, "ADX": 40.0,
        "SMA50": 4600.0, "SMA200": 4400.0, "BB_UPPER": 4800.0,
        "BB_LOWER": 4500.0, "ATR14": 40.0, "PIV_R1": 4750.0, "PIV_S1": 4650.0,
    }
    values.update(overrides)
    for suffix, v in values.items():
        conn.execute("INSERT OR REPLACE INTO prices (symbol, ts, value)"
                     " VALUES (?, ?, ?)", (f"GC_{suffix}", ts, v))
    conn.commit()
    return ts


def test_tv_fallback_ctx_maps_stored_prices_onto_classifier_inputs(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    ts = _seed_tv(conn)
    got = signals.tv_fallback_ctx(conn, "GC")
    assert got is not None
    at, ctx = got
    assert at == ts
    assert ctx["rsi14"] == 30.0
    assert ctx["close"] == 4700.0
    assert ctx["macd_signal"] == 0.0
    assert ctx["pivot_r1"] == 4750.0


def test_tv_fallback_ctx_omits_the_fib_retracements(tmp_path):
    # TradingView's FIB_S1/FIB_R1 are Fibonacci PIVOT levels, a different
    # quantity from indicators.fib_levels' 0.618/0.5 retracements of a
    # lookback range. Feeding one as the other would be silently wrong, so
    # the fallback supplies neither and those classifiers stay unreadable.
    conn = db.connect(tmp_path / "j.db")
    _seed_tv(conn)
    conn.execute("INSERT INTO prices VALUES ('GC_FIB_R1', '2026-08-25T04:31:05Z', 4740.0)")
    conn.execute("INSERT INTO prices VALUES ('GC_FIB_S1', '2026-08-25T04:31:05Z', 4660.0)")
    conn.commit()
    _, ctx = signals.tv_fallback_ctx(conn, "GC")
    assert "fib618" not in ctx
    assert "fib50" not in ctx
    assert signals.classify("fib618", ctx) is None
    assert signals.classify("fib50", ctx) is None


def test_tv_fallback_ctx_is_none_without_prices(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    assert signals.tv_fallback_ctx(conn, "GC") is None


def test_refresh_falls_back_to_tradingview_when_bars_are_absent(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    _seed_tv(conn)
    n = signals.refresh(conn, load_weights(), "GC")
    rows = {r["key"]: r["source"]
            for r in conn.execute("SELECT key, source FROM signal_states")}
    assert n == len(rows)
    # The ten daily signals TradingView can actually feed.
    for key in ("rsi14@1d", "stoch@1d", "willr@1d", "macd@1d", "adx@1d",
                "sma50@1d", "sma200@1d", "bollinger@1d", "pivot@1d"):
        assert key in rows, key
        assert rows[key] == "tradingview"
    # ...and neither retracement, for want of a real equivalent.
    assert "fib618@1d" not in rows and "fib50@1d" not in rows


def test_tv_fallback_covers_the_daily_timeframe_only(tmp_path):
    # docs/todo/003: TradingView's |1W and |240 fields come back null for
    # COMEX:GC1!, so nothing but the daily set is stored to fall back on.
    conn = db.connect(tmp_path / "j.db")
    _seed_tv(conn)
    signals.refresh(conn, load_weights(), "GC")
    keys = {r["key"] for r in conn.execute("SELECT key FROM signal_states")}
    # Assert non-emptiness FIRST: `all()` over an empty set is vacuously
    # true, so without this the test passes just as happily when the
    # fallback writes nothing at all.
    assert keys, "expected the fallback to write daily states"
    assert all(k.endswith("@1d") for k in keys), sorted(keys)


def test_refresh_prefers_bars_over_the_tradingview_fallback(tmp_path):
    # Bars are ours, oracle-checkable and cover every timeframe. The fallback
    # exists for a host with no bars, not as an alternative to having them.
    conn = db.connect(tmp_path / "j.db")
    _seed_tv(conn)
    for tf in ("1d", "4h", "1w"):
        store_bars(conn, "GC", tf, _rising(300))
    signals.refresh(conn, load_weights(), "GC")
    sources = {r["source"] for r in conn.execute(
        "SELECT source FROM signal_states WHERE key LIKE 'rsi14@%'")}
    assert sources == {"bars"}


def test_tv_fallback_reads_atr14_avg_from_stored_atr_history(tmp_path):
    # The atr14 classifier needs a rolling average as well as the level.
    # Fifty stored ATR observations are exactly what the window wants.
    conn = db.connect(tmp_path / "j.db")
    for i in range(60):
        conn.execute("INSERT INTO prices VALUES ('GC_ATR14', ?, ?)",
                     (f"2026-06-{i % 28 + 1:02d}T{i % 24:02d}:00:00Z", 20.0))
    _seed_tv(conn, ATR14=40.0)
    _, ctx = signals.tv_fallback_ctx(conn, "GC")
    assert ctx["atr14"] == 40.0
    assert ctx["atr14_avg"] is not None
    # Volatility at twice its own average reads as expansion, i.e. bullish.
    assert signals.classify("atr14", ctx) == pytest.approx(1.0)


def test_external_series_signals_are_labelled_series_not_bars(tmp_path):
    # GVZ never had bars to compute from — `prices` is its normal path, not
    # a fallback. Labelling it "bars" would claim it went through
    # indicators.py, which is the one thing the oracle test cross-checks.
    conn = db.connect(tmp_path / "j.db")
    for i in range(60):
        conn.execute("INSERT INTO prices VALUES ('^GVZ', ?, 18.0)",
                     (f"2026-07-{i % 28 + 1:02d}T{i % 24:02d}:00:00Z",))
    conn.execute("INSERT INTO prices VALUES ('^GVZ', '2026-08-25T04:00:00Z', 27.0)")
    conn.commit()
    signals.refresh(conn, load_weights(), "GC")
    row = conn.execute(
        "SELECT source FROM signal_states WHERE key = 'gvz@1d'").fetchone()
    assert row is not None, "expected a gvz state from the stored series"
    assert row["source"] == "series"
