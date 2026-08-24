from datetime import datetime, timedelta, timezone

import pytest

from jamasp import db, features
from jamasp.config import load_weights, signal_columns, themes
from jamasp.ingest.bars import TS_FMT, Bar, close_ts, store_bars

# Daily bars start a month BEFORE the hourly ones on purpose. The target
# divides by ATR14, which needs fourteen daily bars to warm up, and `as_of`
# refuses to reach forward — so an hourly row dated before ATR's first
# reading has no divisor and is dropped. Overlapping the two series at the
# same start date would silently empty every target in this file.
DAILY_START = "2026-01-01T00:00:00Z"
HOURLY_START = "2026-02-01T00:00:00Z"


def _ts(start, i, seconds):
    base = datetime.strptime(start, TS_FMT).replace(tzinfo=timezone.utc)
    return (base + timedelta(seconds=i * seconds)).strftime(TS_FMT)


def _hourly(n, start=HOURLY_START):
    """n consecutive hourly bars, +1 per hour so a forward return is exact."""
    return [Bar(_ts(start, i, 3600), 100.0 + i, 101.0 + i, 99.0 + i, 100.0 + i)
            for i in range(n)]


def _daily(n, start=DAILY_START):
    """n daily bars spanning exactly 4 with a mid-range close, so ATR14 is 4."""
    return [Bar(_ts(start, i, 86400), 100.0, 102.0, 98.0, 100.0)
            for i in range(n)]


# ---- as_of ------------------------------------------------------------------

def test_as_of_returns_the_latest_value_at_or_before_the_instant():
    hist = [("2026-01-05T00:00:00Z", 1.0), ("2026-01-06T00:00:00Z", 2.0)]
    assert features.as_of(hist, "2026-01-05T12:00:00Z") == 1.0
    assert features.as_of(hist, "2026-01-06T00:00:00Z") == 2.0
    assert features.as_of(hist, "2026-01-07T00:00:00Z") == 2.0


def test_as_of_returns_none_before_the_first_observation():
    # This is the whole no-lookahead guarantee in one function: an instant
    # earlier than anything observed has no value, and must not borrow the
    # first future one.
    hist = [("2026-01-06T00:00:00Z", 2.0)]
    assert features.as_of(hist, "2026-01-05T23:59:59Z") is None


def test_as_of_of_an_empty_history_is_none():
    assert features.as_of([], "2026-01-05T00:00:00Z") is None


def test_as_of_boundary_is_inclusive_at_t_and_excludes_t_plus_one_second():
    # The no-lookahead guarantee's exact edge, pinned so an O(m) -> O(log m)
    # rewrite of as_of cannot quietly shift it: a state stamped AT t is
    # visible at t (the bar closed exactly then), but a state stamped one
    # second later must not leak backward into this row.
    hist = [("2026-01-06T00:00:00Z", 1.0), ("2026-01-06T00:00:01Z", 2.0)]
    assert features.as_of(hist, "2026-01-06T00:00:00Z") == 1.0
    assert features.as_of(hist, "2026-01-05T23:59:59Z") is None


# ---- target -----------------------------------------------------------------

def test_target_is_the_forward_return_divided_by_atr(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    # +1 per hour, so the 3-hour forward return is exactly +3, over an ATR of 4.
    store_bars(conn, "GC", "1h", _hourly(48))
    store_bars(conn, "GC", "1d", _daily(40))
    out = dict(features.target_series(conn, "GC", horizon_hours=3))
    assert out[HOURLY_START] == pytest.approx(3.0 / 4.0)


def test_target_drops_hours_with_no_future_close(tmp_path):
    # An exact +H lookup is used rather than "the next close after t+H":
    # inventing a return across a weekend gap would be a fabricated
    # observation, and the cost is only that weekend-adjacent hours drop out.
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1h", _hourly(10))
    store_bars(conn, "GC", "1d", _daily(40))
    stamps = [ts for ts, _ in features.target_series(conn, "GC", horizon_hours=3)]
    # 10 hourly bars, horizon 3 -> the last three have no future close.
    assert len(stamps) == 7
    assert _ts(HOURLY_START, 7, 3600) not in stamps


def test_target_is_empty_when_the_hourly_window_predates_atr(tmp_path):
    # The divisor cannot be borrowed from the future. An hourly series that
    # starts before ATR14's first daily reading yields no rows at all —
    # which is the correct answer, and the reason DAILY_START leads
    # HOURLY_START by a month everywhere else in this file.
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1h", _hourly(48, start=DAILY_START))
    store_bars(conn, "GC", "1d", _daily(40))
    assert features.target_series(conn, "GC", horizon_hours=3) == []


def test_target_is_empty_when_atr_has_not_warmed_up(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    store_bars(conn, "GC", "1h", _hourly(48))
    store_bars(conn, "GC", "1d", _daily(5))   # far short of ATR14's 14 bars
    assert features.target_series(conn, "GC", horizon_hours=3) == []


# ---- no lookahead -----------------------------------------------------------

def test_a_state_is_not_visible_before_its_bar_closes(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    daily = _daily(60)
    store_bars(conn, "GC", "1d", daily)
    hist = features.column_history(conn, load_weights(), "GC")

    # The earliest instant ANY daily state could legitimately carry is the
    # close of the very first daily bar. A stamp at or before that bar's OPEN
    # would mean the state was readable while the bar was still forming —
    # which is the exact defect this asserts against, and the reason
    # bar_states stamps with close_ts rather than the stored ts.
    earliest = close_ts(daily[0].ts, "1d")
    checked = 0
    for key, points in hist.items():
        if not key.endswith("@1d") or not points:
            continue
        checked += 1
        assert points[0][0] >= earliest, (key, points[0][0], earliest)
        assert points == sorted(points), f"{key} history must be ascending"
    assert checked > 0, "no daily column produced any state — the test proved nothing"


def test_states_are_forward_filled_between_bar_closes():
    # A daily state holds for the 24 hours after its bar closed, then the next
    # one replaces it. Interpolating between them would invent readings.
    hist = [("2026-01-06T00:00:00Z", 0.5), ("2026-01-07T00:00:00Z", -0.5)]
    assert features.as_of(hist, "2026-01-06T00:00:00Z") == 0.5
    assert features.as_of(hist, "2026-01-06T23:00:00Z") == 0.5
    assert features.as_of(hist, "2026-01-07T01:00:00Z") == -0.5


# ---- technical matrix -------------------------------------------------------

def _seed_bars(conn, hours=200):
    store_bars(conn, "GC", "1h", _hourly(hours))
    store_bars(conn, "GC", "4h", _hourly(hours))
    store_bars(conn, "GC", "1d", _daily(60))
    store_bars(conn, "GC", "1w", _daily(60))


def test_technical_matrix_columns_are_the_configured_signal_columns(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    data = features.build_technical(conn, load_weights(), "GC")
    assert data.columns == signal_columns(load_weights())
    assert len(data.X) == len(data.y) == len(data.rows)
    assert all(len(row) == len(data.columns) for row in data.X)


def test_technical_matrix_fills_an_unread_column_with_neutral_and_counts_it(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    weights = load_weights()
    data = features.build_technical(conn, weights, "GC")
    # sma200@1w needs 200 weekly bars; there are 60 here, so it is never
    # read. Its column must be all-neutral AND report zero observations,
    # so the fit can refuse to publish a coefficient for it rather than
    # fitting one to a column of zeros.
    idx = data.columns.index("sma200@1w")
    assert all(row[idx] == 0.0 for row in data.X)
    assert data.observations["sma200@1w"] == 0
    assert data.observations["rsi14@1d"] > 0


def test_technical_matrix_is_empty_without_bars(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    data = features.build_technical(conn, load_weights(), "GC")
    assert data.X == [] and data.y == []


# ---- theme matrix -----------------------------------------------------------

def _score(conn, item_id, published_at, tier, theme):
    conn.execute(
        "INSERT INTO items (id, source, published_at, headline, url, topic, fetched_at)"
        " VALUES (?, 'test', ?, 'h', 'https://x/' || ?, 'gold', ?)",
        (item_id, published_at, item_id, published_at))
    conn.execute(
        "INSERT INTO item_scores (item_id, tier, direction, conviction, theme, scored_at)"
        " VALUES (?, ?, 1, 0.8, ?, ?)",
        (item_id, tier, theme, published_at))
    conn.commit()


def test_theme_exposure_sums_tier_weights_within_the_hour(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    # Two tier-5 stories (100 each) in the same hour, one tier-3 (30) in the
    # next. The timestamps sit inside the hourly grid _seed_bars laid down.
    _score(conn, "a", "2026-02-02T02:10:00Z", 5, "rates_dollar")
    _score(conn, "b", "2026-02-02T02:50:00Z", 5, "rates_dollar")
    _score(conn, "c", "2026-02-02T03:05:00Z", 3, "rates_dollar")
    data = features.build_theme(conn, load_weights(), "GC")
    idx = data.columns.index("rates_dollar")
    by_hour = {ts: row[idx] for ts, row in zip(data.rows, data.X)}
    assert by_hour["2026-02-02T02:00:00Z"] == pytest.approx(200.0)
    assert by_hour["2026-02-02T03:00:00Z"] == pytest.approx(30.0)
    assert by_hour["2026-02-02T04:00:00Z"] == pytest.approx(0.0)


def test_theme_matrix_carries_the_signal_columns_as_controls(tmp_path):
    # Without these the fit credits news with moves the tape was already
    # making. They are the entire reason Fit B is not just Fit A with
    # different columns.
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    _score(conn, "a", "2026-02-02T02:10:00Z", 5, "rates_dollar")
    weights = load_weights()
    data = features.build_theme(conn, weights, "GC")
    assert data.columns[: len(themes(weights))] == themes(weights)
    assert data.columns[len(themes(weights)):] == signal_columns(weights)


def test_theme_matrix_starts_at_the_first_scored_item(tmp_path):
    # Hours before any story was scored carry a genuine zero for every theme,
    # but they are not observations of "no news moved gold" — they are hours
    # in which nothing was being classified at all.
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    _score(conn, "a", "2026-02-02T02:10:00Z", 5, "rates_dollar")
    data = features.build_theme(conn, load_weights(), "GC")
    assert data.rows[0] >= "2026-02-02T02:00:00Z"


def test_theme_matrix_is_empty_with_no_scored_items(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    data = features.build_theme(conn, load_weights(), "GC")
    assert data.X == [] and data.y == []


def test_build_theme_raises_when_hourly_bars_are_stamped_off_the_hour(tmp_path):
    # This is the documentation of the assumption `_theme_exposure` and
    # `build_theme` rest on, unverified against live Yahoo data (429 on
    # every attempt so far, per Finding 5). `_theme_exposure` keys exposure
    # at the UTC HOUR an item published ("...T02:10:00Z" -> "...T02:00:00Z"),
    # and this reads it back with the hourly bar's OWN stored ts. Every
    # other test in this file seeds bars on the hour, so the join has only
    # ever been checked against itself. Stamp bars at :30 past the hour
    # instead -- every lookup misses, every theme column is zero for every
    # row, and that must fail loudly rather than render as "not enough news
    # yet".
    conn = db.connect(tmp_path / "j.db")
    off_hour_start = "2026-02-01T00:30:00Z"
    store_bars(conn, "GC", "1h", _hourly(200, start=off_hour_start))
    store_bars(conn, "GC", "4h", _hourly(200, start=off_hour_start))
    store_bars(conn, "GC", "1d", _daily(60))
    store_bars(conn, "GC", "1w", _daily(60))
    # Published well inside the seeded bar range, on the hour as every real
    # item's published_at is -- it is the BAR that is off, not the story.
    _score(conn, "a", "2026-02-02T02:10:00Z", 5, "rates_dollar")
    _score(conn, "b", "2026-02-02T05:40:00Z", 4, "geopolitics")

    with pytest.raises(RuntimeError, match="join"):
        features.build_theme(conn, load_weights(), "GC")


def test_theme_matrix_counts_observations_per_hour_not_per_story(tmp_path):
    # "Missing is neutral, and counted" applies to the theme columns too:
    # theme_obs counts HOURS with exposure, not stories. Two stories landing
    # in the same hour are one row of evidence, not two -- counting items
    # instead of distinct hours would inflate this and let a thin column
    # pass Task 7's min_observations threshold it shouldn't. A theme with no
    # scored stories anywhere must report zero, and the merged dict must
    # still carry both the theme columns and the signal columns Task 7
    # reads for its fitted-flag decision on both maps.
    conn = db.connect(tmp_path / "j.db")
    _seed_bars(conn)
    _score(conn, "a", "2026-02-02T02:10:00Z", 5, "rates_dollar")
    _score(conn, "b", "2026-02-02T02:50:00Z", 5, "rates_dollar")  # same hour as a
    _score(conn, "c", "2026-02-02T05:05:00Z", 3, "rates_dollar")  # a distinct hour
    _score(conn, "d", "2026-02-02T09:20:00Z", 3, "rates_dollar")  # a third hour
    weights = load_weights()
    data = features.build_theme(conn, weights, "GC")
    # 4 stories land in 3 distinct hours; counting stories would give 4.
    assert data.observations["rates_dollar"] == 3
    assert data.observations["geopolitics"] == 0
    assert data.observations["other"] == 0
    for col in themes(weights) + signal_columns(weights):
        assert col in data.observations
    assert data.observations["rsi14@1d"] > 0  # the merge didn't drop signal columns
