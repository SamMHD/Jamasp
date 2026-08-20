import json
import random

import pytest

from jamasp import db, fit
from jamasp.config import load_weights


def _synthetic(n, coefs, noise=0.0, seed=20260820):
    """Rows whose target is a known linear combination of the columns.

    A seeded RNG rather than a modular pattern like `(i + j*7) % 11`: cyclic
    patterns make the columns near-perfect shifts of one another, and ridge
    splits an effect across collinear predictors — so the recovered ratios
    would reflect the collinearity rather than the coefficients this is
    supposed to recover. Seeded means deterministic; uncorrelated means the
    assertions test what they claim to.
    """
    rng = random.Random(seed)
    X, y = [], []
    for _ in range(n):
        row = [rng.uniform(-1.0, 1.0) for _ in coefs]
        X.append(row)
        y.append(sum(c * v for c, v in zip(coefs, row))
                 + noise * rng.uniform(-1.0, 1.0))
    return X, y


# ---- the ridge itself -------------------------------------------------------

def test_ridge_recovers_known_coefficients():
    # Ridge shrinks, so the recovered ratios matter more than the magnitudes:
    # a column with three times another's true effect must come out roughly
    # three times larger.
    X, y = _synthetic(400, [3.0, 1.0, 0.0])
    betas, _ = fit.ridge(X, y, alpha=0.1)
    assert betas[0] > betas[1] > 0
    assert betas[0] / betas[1] == pytest.approx(3.0, rel=0.25)
    assert abs(betas[2]) < 0.1


def test_ridge_shrinks_more_at_higher_alpha():
    X, y = _synthetic(400, [3.0, 1.0, 0.0])
    weak, _ = fit.ridge(X, y, alpha=0.1)
    strong, _ = fit.ridge(X, y, alpha=1000.0)
    assert abs(strong[0]) < abs(weak[0])


def test_ridge_gives_a_zero_variance_column_a_zero_coefficient():
    # A constant column carries no information. Standardising it would divide
    # by zero; the fit must hand back 0.0, not a NaN that poisons every
    # downstream multiplier.
    X, y = _synthetic(300, [2.0, 1.0])
    for row in X:
        row.append(5.0)
    betas, ses = fit.ridge(X, y, alpha=1.0)
    assert betas[2] == 0.0
    assert ses[2] == 0.0


def test_ridge_standard_errors_are_positive_and_finite():
    X, y = _synthetic(400, [3.0, 1.0, 0.0], noise=0.5)
    _, ses = fit.ridge(X, y, alpha=1.0)
    assert all(s > 0 for s in ses[:3])


def test_ridge_standard_errors_shrink_with_more_rows():
    Xs, ys = _synthetic(120, [2.0, 1.0], noise=0.5)
    Xl, yl = _synthetic(1200, [2.0, 1.0], noise=0.5)
    _, se_small = fit.ridge(Xs, ys, alpha=1.0)
    _, se_large = fit.ridge(Xl, yl, alpha=1.0)
    assert se_large[0] < se_small[0]


# ---- multipliers ------------------------------------------------------------

def test_positive_multipliers_average_one_before_clamping():
    ms, flags = fit.to_multipliers([1.0, 2.0, 3.0], lo=0.01, hi=100.0)
    assert sum(ms) / len(ms) == pytest.approx(1.0)
    assert flags == []


def test_multipliers_clamp_to_the_configured_band():
    # beta_bar here is mean([1]*9 + [100]) = 10.9, so the outlier's raw
    # multiplier is 9.17 (clamps to the ceiling) and each 1.0 gives 0.092
    # (clamps to the floor). Note that clamping breaks the mean-1.0 property
    # — deliberately: a bounded area channel matters more than an exact mean.
    ms, _ = fit.to_multipliers([1.0] * 9 + [100.0], lo=0.25, hi=3.0)
    assert ms[-1] == 3.0
    assert ms[0] == 0.25
    assert all(0.25 <= m <= 3.0 for m in ms)


def test_a_negative_coefficient_clamps_to_the_floor_and_flags():
    # A negative coefficient means items scored bullish were followed by gold
    # going DOWN — evidence the direction scoring is wrong, not that the
    # theme should shrink. abs() would bury the single most useful thing the
    # regression can report.
    ms, flags = fit.to_multipliers([2.0, -1.0], lo=0.25, hi=3.0)
    assert ms[1] == 0.25
    assert any("negative" in f for f in flags)


def test_negative_coefficients_do_not_enter_the_normalising_mean():
    # Otherwise one bad column drags the mean toward zero and inflates every
    # other multiplier — or flips their signs when the mean goes negative.
    with_neg, _ = fit.to_multipliers([1.0, 3.0, -8.0], lo=0.01, hi=100.0)
    without, _ = fit.to_multipliers([1.0, 3.0], lo=0.01, hi=100.0)
    assert with_neg[:2] == pytest.approx(without)


def test_all_negative_coefficients_yield_neutral_multipliers_and_a_flag():
    ms, flags = fit.to_multipliers([-1.0, -2.0], lo=0.25, hi=3.0)
    assert ms == [1.0, 1.0]
    assert "degenerate_mean" in flags


# ---- run_fit ----------------------------------------------------------------

def _data(columns, X, y, observations=None):
    from jamasp.features import TrainingData

    obs = observations or {c: len(X) for c in columns}
    return TrainingData(tuple(columns), tuple(str(i) for i in range(len(X))),
                        X, y, obs)


CFG = {"horizon_hours": 24, "ridge_alpha": 1.0, "min_rows": 200,
       "multiplier_min": 0.25, "multiplier_max": 3.0, "min_observations": 50}


def test_run_fit_refuses_below_min_rows():
    X, y = _synthetic(10, [1.0, 1.0])
    assert fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {}) is None


def test_run_fit_marks_an_under_observed_column_unfitted():
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y, {"a": 400, "b": 3}),
                      CFG, {})
    by_key = {c.key: c for c in res.coefficients}
    assert by_key["a"].fitted is True
    # 3 observations is not a measurement. Publishing a coefficient for it
    # would render a confidently-sized tile built on nothing.
    assert by_key["b"].fitted is False
    assert by_key["b"].multiplier == 1.0


def test_run_fit_applies_a_pin_over_the_fitted_value():
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {"a": 2.5})
    by_key = {c.key: c for c in res.coefficients}
    assert by_key["a"].multiplier == 2.5
    assert by_key["b"].multiplier != 2.5


def test_run_fit_reports_only_the_requested_columns():
    # Fit B fits over themes AND controls but reports only the themes: the
    # control coefficients exist to absorb the tape, not to be published.
    X, y = _synthetic(400, [3.0, 1.0, 0.5])
    res = fit.run_fit("theme", _data(["t1", "t2", "ctrl"], X, y), CFG, {},
                      report_columns=("t1", "t2"))
    assert [c.key for c in res.coefficients] == ["t1", "t2"]


def test_run_fit_records_n_and_the_hyperparameters():
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {})
    assert res.n == 400
    assert res.horizon_hours == 24 and res.ridge_alpha == 1.0


# ---- persistence ------------------------------------------------------------

def test_write_results_produces_readable_json_and_db_rows(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {})
    out = tmp_path / "weights.json"
    fit.write_results(conn, out, [res], "2026-08-20T04:17:00Z")

    doc = json.loads(out.read_text())
    assert doc["fitted_at"] == "2026-08-20T04:17:00Z"
    assert doc["fits"]["technical"]["n"] == 400
    entry = doc["fits"]["technical"]["coefficients"]["a"]
    assert set(entry) == {"beta", "se", "multiplier", "observations", "fitted"}

    rows = conn.execute("SELECT fit, key, multiplier FROM weight_fits").fetchall()
    assert {r["key"] for r in rows} == {"a", "b"}


def test_write_results_appends_a_second_fit_rather_than_replacing(tmp_path):
    # weight_fits is the trajectory. Overwriting would leave the panel able to
    # show a number but never how it got there.
    conn = db.connect(tmp_path / "j.db")
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {})
    fit.write_results(conn, tmp_path / "w.json", [res], "2026-08-20T04:17:00Z")
    fit.write_results(conn, tmp_path / "w.json", [res], "2026-08-21T04:17:00Z")
    stamps = {r["fitted_at"] for r in conn.execute("SELECT fitted_at FROM weight_fits")}
    assert stamps == {"2026-08-20T04:17:00Z", "2026-08-21T04:17:00Z"}


def test_write_results_is_atomic(tmp_path):
    # The panel reads this file on every request. A half-written file would
    # be a JSON parse error on a live page, so the write goes via a temp file
    # and a rename.
    conn = db.connect(tmp_path / "j.db")
    X, y = _synthetic(400, [3.0, 1.0])
    res = fit.run_fit("technical", _data(["a", "b"], X, y), CFG, {})
    out = tmp_path / "weights.json"
    fit.write_results(conn, out, [res], "2026-08-20T04:17:00Z")
    assert json.loads(out.read_text())["fits"]["technical"]["n"] == 400
    assert not list(tmp_path.glob("*.tmp"))
