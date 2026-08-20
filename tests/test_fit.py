import json
import random

import numpy as np
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


def test_ridge_standard_errors_use_the_ridge_covariance_not_the_ols_form():
    # The two SE tests above use alpha=1.0, same as every other ridge test in
    # this file -- and at alpha=1.0 the ridge covariance
    # sigma^2 * A^-1 (Z'Z) A^-1 and the plain OLS form sigma^2 * A^-1 (where
    # A = Z'Z + alpha*I) are numerically indistinguishable for this fixture
    # (ratio ~0.999), so neither test can tell which formula shipped. The two
    # forms only separate once alpha is large relative to n: with
    # standardised columns Z'Z ~= n*I, so se_ridge/se_ols ~= sqrt(n/(n+alpha)).
    # n=400 and alpha=400 predicts a ratio of sqrt(0.5) ~= 0.707 -- a
    # decisive ~30% gap, not noise.
    n = 400
    alpha = 400.0
    X, y = _synthetic(n, [3.0, 1.0, 0.0], noise=0.5)
    betas, ses = fit.ridge(X, y, alpha)

    # Reproduce the same standardised regression independently -- same
    # centering, same solve, same residuals and sigma^2 -- so the only thing
    # that can differ between our replica and the shipped SEs is which
    # matrix sandwiches sigma^2.
    A = np.asarray(X, dtype=float)
    b = np.asarray(y, dtype=float)
    sd = A.std(axis=0)
    Z = (A - A.mean(axis=0)) / sd
    yc = b - b.mean()
    gram = Z.T @ Z
    reg = gram + alpha * np.eye(Z.shape[1])
    beta_live = np.linalg.solve(reg, Z.T @ yc)
    resid = yc - Z @ beta_live
    sigma2 = float(resid @ resid) / (n - Z.shape[1])
    inv = np.linalg.inv(reg)

    ridge_se = np.sqrt(np.diag(sigma2 * inv @ gram @ inv))
    ols_se = np.sqrt(np.diag(sigma2 * inv))

    # The shipped SEs track the ridge form...
    assert ses[:3] == pytest.approx(ridge_se.tolist(), rel=1e-6)
    # ...and sit materially below what the OLS form would give for the same
    # fit -- exactly the property that would be lost if `cov = sigma2 * inv`
    # were substituted for `cov = sigma2 * inv @ gram @ inv`.
    predicted_ratio = (n / (n + alpha)) ** 0.5
    observed_ratio = np.array(ses[:3]) / ols_se
    assert observed_ratio == pytest.approx(predicted_ratio, rel=0.1)
    assert all(se < 0.85 * o for se, o in zip(ses[:3], ols_se))


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


# ---- Fit B: theme weights with technical controls ---------------------------

def _tape_driven(n, seed=7):
    """News that arrives when the tape is already strong, and a target that
    is entirely explained by the tape.

    The exposure is CORRELATED with the technical state, not determined by
    it. A deterministic `exposure = 100 if s > 0` makes the two columns
    perfectly collinear, and ridge splits an effect across collinear
    predictors rather than assigning it — so the controlled coefficient
    would stay large and the test would fail for a reason that has nothing
    to do with whether the controls work.
    """
    rng = random.Random(seed)
    X_theme, X_ctrl, y = [], [], []
    for _ in range(n):
        s = rng.uniform(-1.0, 1.0)                 # the technical state
        # Stories land more often on a strong tape, but not always.
        X_theme.append(100.0 if s + rng.gauss(0, 0.6) > 0 else 0.0)
        X_ctrl.append(s)
        y.append(2.0 * s)                          # the move is ALL tape
    return X_theme, X_ctrl, y


def test_controls_strip_a_theme_effect_the_tape_already_explains():
    # This is the whole point of Fit B. If it does not discriminate, the
    # controls are decorative and news is credited with moves the tape was
    # already making.
    theme, ctrl, y = _tape_driven(600)

    naive = fit.run_fit(
        "theme", _data(["rates_dollar"], [[t] for t in theme], y),
        CFG, {}, report_columns=("rates_dollar",))
    controlled = fit.run_fit(
        "theme", _data(["rates_dollar", "sma50@1d"],
                       [[t, c] for t, c in zip(theme, ctrl)], y),
        CFG, {}, report_columns=("rates_dollar",))

    naive_beta = abs(naive.coefficients[0].beta)
    controlled_beta = abs(controlled.coefficients[0].beta)
    assert naive_beta > 0.1, "the uncontrolled fit should see a large theme effect"
    assert controlled_beta < 0.25 * naive_beta, (naive_beta, controlled_beta)


def test_fit_all_runs_both_fits_when_both_have_rows(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    X, y = _synthetic(400, [3.0, 1.0])
    # Patch the names bound INSIDE jamasp.fit. fit.py does
    # `from jamasp.features import build_technical`, so patching
    # jamasp.features.build_technical would rebind a name fit.py no longer
    # reads — a patch that silently does nothing.
    monkeypatch.setattr(fit, "build_technical",
                        lambda *a, **k: _data(["rsi14@1d", "sma50@1d"], X, y))
    monkeypatch.setattr(fit, "build_theme",
                        lambda *a, **k: _data(["rates_dollar", "rsi14@1d"], X, y))

    results = fit.fit_all(conn, load_weights(), "GC", today="2026-08-20")
    assert [r.name for r in results] == ["technical", "theme"]


def test_fit_b_reports_themes_only_never_its_controls(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    X, y = _synthetic(400, [3.0, 1.0])
    monkeypatch.setattr(fit, "build_technical", lambda *a, **k: _data([], [], []))
    monkeypatch.setattr(
        fit, "build_theme",
        lambda *a, **k: _data(["rates_dollar", "rsi14@1d"], X, y))

    results = fit.fit_all(conn, load_weights(), "GC", today="2026-08-20")
    theme_fit = next(r for r in results if r.name == "theme")
    keys = [c.key for c in theme_fit.coefficients]
    assert "rates_dollar" in keys
    # The control coefficients absorb the tape; publishing them here would
    # give the fundamental map a second, contradictory set of technical
    # weights alongside Fit A's.
    assert "rsi14@1d" not in keys
