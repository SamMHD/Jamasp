"""Ridge fits over the hourly matrix, and the multipliers they produce.

numpy rather than a hand-rolled solve. The hand-rolled version is about sixty
lines and runs in five to fifteen seconds, both acceptable — it is rejected
because numerics a reader must AUDIT are worse than numerics a reader
RECOGNISES. np.linalg.solve is a line anyone can check against a textbook.

The normalisation is `m = beta / beta_bar` where beta_bar is the mean of the
strictly POSITIVE coefficients, so before clamping the positive multipliers
average exactly 1.0. Negative coefficients stay out of that mean and clamp to
the floor with a flag: a negative coefficient means items scored bullish were
followed by gold going down, which is evidence the DIRECTION SCORING is wrong
for that column, not that the column should shrink. abs() would bury the
single most useful thing the regression can report.

One caveat, recorded rather than hidden: at H = 24h consecutive rows have
overlapping target windows, which autocorrelates residuals. That inflates
apparent significance without biasing the coefficients — which is why this
module reports standard errors and sample counts and never a p-value. A
p-value here would be quietly wrong in a way that looks authoritative.
"""
from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from jamasp.config import active_pins, fit_config, themes
from jamasp.db import utcnow
from jamasp.features import TrainingData, build_technical, build_theme


@dataclass(frozen=True)
class Coefficient:
    key: str
    beta: float
    se: float
    multiplier: float
    observations: int
    fitted: bool


@dataclass(frozen=True)
class FitResult:
    name: str
    n: int
    horizon_hours: int
    ridge_alpha: float
    coefficients: list[Coefficient]
    flags: list[str]


def ridge(X: list[list[float]], y: list[float], alpha: float
          ) -> tuple[list[float], list[float]]:
    """Standardised ridge. Returns (betas, standard errors).

    Columns are z-scored so coefficients are comparable across features that
    live on different scales — which is the entire point, since the
    multipliers are ratios between them. A zero-variance column would divide
    by zero when standardising; it carries no information, so it is zeroed
    out rather than allowed to produce a NaN that poisons every other
    multiplier through the normalising mean.
    """
    A = np.asarray(X, dtype=float)
    b = np.asarray(y, dtype=float)
    n, p = A.shape

    sd = A.std(axis=0)
    live = sd > 1e-12
    betas = np.zeros(p)
    ses = np.zeros(p)
    if not live.any():
        return betas.tolist(), ses.tolist()

    Z = (A[:, live] - A[:, live].mean(axis=0)) / sd[live]
    yc = b - b.mean()

    gram = Z.T @ Z
    reg = gram + alpha * np.eye(Z.shape[1])
    beta_live = np.linalg.solve(reg, Z.T @ yc)

    resid = yc - Z @ beta_live
    dof = max(1, n - Z.shape[1])
    sigma2 = float(resid @ resid) / dof
    # Ridge covariance: sigma^2 * (Z'Z + aI)^-1 Z'Z (Z'Z + aI)^-1. The plain
    # OLS form would understate the error at any alpha above zero.
    inv = np.linalg.inv(reg)
    cov = sigma2 * inv @ gram @ inv
    se_live = np.sqrt(np.clip(np.diag(cov), 0.0, None))

    betas[live] = beta_live
    ses[live] = se_live
    return betas.tolist(), ses.tolist()


def to_multipliers(betas: list[float], lo: float, hi: float
                   ) -> tuple[list[float], list[str]]:
    """Coefficients -> clamped multipliers, plus any flags raised."""
    flags: list[str] = []
    positives = [b for b in betas if b > 0]
    if not positives:
        # Nothing to normalise against. Neutral multipliers are the honest
        # answer; a map of equal tiles says "no read yet" rather than
        # inventing an ordering out of noise.
        return [1.0] * len(betas), ["degenerate_mean"]

    bar = sum(positives) / len(positives)
    out: list[float] = []
    for i, b in enumerate(betas):
        if b < 0:
            flags.append(f"negative:{i}")
            out.append(lo)
        else:
            out.append(max(lo, min(hi, b / bar)))
    return out, flags


def run_fit(name: str, data: TrainingData, cfg: dict, pins: dict[str, float],
            report_columns: tuple[str, ...] | None = None) -> FitResult | None:
    """One ridge fit. None when there are not enough rows to justify one."""
    if len(data.y) < cfg["min_rows"]:
        return None

    betas, ses = ridge(data.X, data.y, cfg["ridge_alpha"])
    multipliers, flags = to_multipliers(
        betas, cfg["multiplier_min"], cfg["multiplier_max"])
    # Re-label the positional flags to_multipliers emitted with real keys.
    flags = [
        f"negative:{data.columns[int(f.split(':')[1])]}" if f.startswith("negative:") else f
        for f in flags
    ]

    keep = report_columns if report_columns is not None else data.columns
    coefficients: list[Coefficient] = []
    for col in keep:
        # A requested column absent from the matrix is skipped rather than
        # raising: callers ask for a whole taxonomy (every theme slot) and a
        # matrix built from a database with no stories in one of them
        # legitimately has no column for it.
        if col not in data.columns:
            continue
        j = data.columns.index(col)
        obs = data.observations.get(col, 0)
        fitted = obs >= cfg["min_observations"]
        # An under-observed column renders neutral and dashed rather than
        # publishing a coefficient estimated from a handful of rows.
        m = multipliers[j] if fitted else 1.0
        if col in pins:
            m = pins[col]
        coefficients.append(Coefficient(
            key=col, beta=betas[j], se=ses[j], multiplier=m,
            observations=obs, fitted=fitted))

    return FitResult(name=name, n=len(data.y), horizon_hours=cfg["horizon_hours"],
                     ridge_alpha=cfg["ridge_alpha"], coefficients=coefficients,
                     flags=flags)


def write_results(conn: sqlite3.Connection, path: Path,
                  results: list[FitResult], fitted_at: str) -> None:
    """Publish the current fit to JSON and append it to the trajectory table.

    The JSON write goes via a temp file and a rename because the panel reads
    it on every request: a half-written file would surface as a JSON parse
    error on a live page.
    """
    doc = {"fitted_at": fitted_at, "fits": {}}
    for r in results:
        doc["fits"][r.name] = {
            "n": r.n,
            "horizon_hours": r.horizon_hours,
            "ridge_alpha": r.ridge_alpha,
            "flags": r.flags,
            "coefficients": {
                c.key: {"beta": c.beta, "se": c.se, "multiplier": c.multiplier,
                        "observations": c.observations, "fitted": c.fitted}
                for c in r.coefficients
            },
        }
        conn.executemany(
            "INSERT INTO weight_fits (fitted_at, fit, key, beta, se, multiplier, n)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(fitted_at, r.name, c.key, c.beta, c.se, c.multiplier, r.n)
             for c in r.coefficients],
        )
    conn.commit()

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=1))
    os.replace(tmp, path)


def fit_all(conn: sqlite3.Connection, weights: dict, symbol: str = "GC",
            today: str | None = None) -> list[FitResult]:
    """Every fit this deployment can currently support.

    Two fits, not one. Technical signals backfill five years while scored news
    starts 2026-08-19, so a single joint fit over all history would have every
    theme column zero for ~99.9% of rows: theme coefficients estimated from
    tens of rows while the reported n said thousands, making the confidence
    treatment overstate certainty exactly where it is least deserved.

    Fit B carries the signal states as CONTROLS and reports only the themes.
    The control coefficients are discarded — they exist so a news effect is
    not credited with a move the tape was already making, not to become a
    second, contradictory set of technical weights alongside Fit A's.

    A full refit from history each time, not an incremental nudge:
    idempotent, reproducible, no drift.
    """
    cfg = fit_config(weights)
    pins = active_pins(weights, (today or utcnow())[:10])
    results: list[FitResult] = []

    a = run_fit("technical", build_technical(conn, weights, symbol), cfg, pins)
    if a is not None:
        results.append(a)

    theme_data = build_theme(conn, weights, symbol)
    b = run_fit("theme", theme_data, cfg, pins, report_columns=themes(weights))
    if b is not None:
        results.append(b)

    return results
