---
id: 016
title: Fit B normalises theme multipliers against the control columns, so they land 17x too low and in the wrong order
status: done
opened: 2026-09-06
owner: unassigned
closed: 2026-09-06
---

## Problem

`jamasp/fit.py#to_multipliers` divides every coefficient by `β̄`, the mean of
the **strictly positive coefficients in the matrix it was handed**. For Fit A
(technical) that matrix is exactly the set of columns the fit reports, and the
normalisation is correct.

Fit B is the only caller that passes `report_columns`. Its matrix is 44
columns — 6 theme slots **plus the 38 technical signal states carried as
controls** — and `run_fit` then reports only the 6 themes, discarding the
controls. But `to_multipliers` ran over all 44, so `β̄` was computed from
coefficients that are never published and are an order of magnitude larger
than the ones that are.

The consequence is that the design's stated invariant is not met. From
`docs/superpowers/specs/2026-08-20-market-maps-learning-loop-design.md`:

> The multiplier is `β / β̄`, normalised so the mean is 1.0

For the published theme set the mean is **0.375**, and no theme reaches 1.0
by measurement at all.

## Why it matters

Every published theme multiplier is pushed 16.8× toward zero, which puts all
of them on or under the `multiplier_min` floor of 0.25. That erases the
ordering the regression actually found and replaces it with the floor.

Worse, what survives is **inverted**. `geopolitics` has the largest positive
theme coefficient and ships at 0.25; `physical_cb` has a coefficient seven
times smaller and ships at 1.0, because its 16 observations fall short of
`min_observations: 50` and it falls back to neutral — and neutral, on the
contaminated scale, is four times the largest measured value. So "we could
not measure this theme" outranks "this is the strongest theme we measured".

That inversion reached the desk. Until PR #35 the fundamental map multiplied
tile area by this number, and on 2026-09-06 the largest tile on the 24h map
was a **tier 4** at 2.33× the area of the day's only **tier 5**. PR #35 took
the multiplier out of the area channel, so nothing currently renders from
these values — which is why this is a todo and not an incident. It becomes
live again the moment anything displays or acts on a theme multiplier,
including the theme-header treatment PR #35 leaves as follow-up, and
including the retro reading these numbers to decide a pin.

## Evidence

Checked 2026-09-06 against a read-only copy of the production database
(`/home/jamasp/Jamasp/state/jamasp.db`, 20.4 MB, copied at 15:32Z) and the
host's `config/weights.yaml` (md5 `fde886ff…`, identical to the repo copy on
`main`).

`state/weights.json` on the host, `fits.theme`, `fitted_at
2026-09-05T23:37:55Z`, n=233:

| theme | β | SE | \|β\|/SE | obs | fitted | shipped multiplier |
|---|---|---|---|---|---|---|
| rates_dollar | −0.010628 | 0.024956 | 0.43 | 211 | yes | 0.25 |
| geopolitics | **+0.020691** | 0.025747 | 0.80 | 202 | yes | **0.25** |
| physical_cb | +0.002825 | 0.023780 | 0.12 | 16 | no | **1.00** |
| etf_flows | −0.004961 | 0.023939 | 0.21 | 3 | no | 1.00 |
| supply_mining | −0.015962 | 0.024189 | 0.66 | 67 | yes | 0.25 |
| other | −0.002437 | 0.023980 | 0.10 | 146 | yes | 0.25 |

Fit B re-run read-only against that snapshot (numbers reproduce the shipped
multipliers exactly, so this is the same fit, not an approximation):

```
rows n=233  columns=44 (themes=6, controls=38)
positive betas in the whole matrix: 19
bar over ALL columns   (what to_multipliers uses) = 0.197015
bar over THEME columns (what the design describes) = 0.011758
ratio = 16.76x

theme                  beta        se   obs  shipped theme-only
geopolitics       +0.020691  0.025747   202   0.2500     1.7597
physical_cb       +0.002825  0.023780    16   1.0000     0.2500

control columns' betas (discarded by run_fit, but they set bar):
  fib50@4h       |beta|=0.853719
  rsi14@4h       |beta|=0.826024
  adx@4h         |beta|=0.669202
```

Two further confirmations that the controls went through `to_multipliers`:

- `fits.theme.flags` in `state/weights.json` names signal columns —
  `negative:sma50@4h`, `negative:macd@1d`, … — even though Fit B reports no
  signal coefficients. Those flags can only come from `to_multipliers`
  iterating the control columns.
- `weight_fits` holds exactly two fits, both on 2026-09-05 (21:33:46Z and
  23:37:55Z), with identical values. There is no earlier fit to compare
  against; this has been the behaviour since the first fit ever succeeded.

**Stated negative:** Fit A is *not* affected. `run_fit` is called for
"technical" with `report_columns=None`, so `keep == data.columns` and `β̄`
is taken over exactly the columns that get published. Do not "fix" Fit A.

**Also true, and a separate question from this one:** at n=233 none of the
six theme coefficients is distinguishable from zero (largest \|β\|/SE = 0.80).
Correcting the normalisation would produce a correctly-ordered set of
multipliers estimated from noise. Whether the theme fit should publish
anything at all before its coefficients clear some multiple of their standard
error is a decision for the retro, not a bug fix.

## Fix

In `jamasp/fit.py`, compute the normalising mean over the columns the fit
will actually report, not over the whole matrix. `to_multipliers` currently
takes a bare `betas` list; it needs to know which positions are reported —
either by taking the `keep` index set, or by having `run_fit` slice the
reported betas before normalising and map the multipliers back.

Whatever the shape, the flag re-labelling in `run_fit` must keep working, and
the `negative:` flags for control columns should either stop being emitted or
be clearly marked as controls: a retro reading "negative:macd@4h" out of a
*theme* fit currently has no way to tell it is looking at a discarded column.

Do this carefully and behind tests. These fits only started succeeding on
2026-09-05 after twelve days of failure (`docs/todo/012`, PRs #28 and #30);
a regression here is expensive to notice.

## Done when

- Fit B's published theme multipliers have a mean of 1.0 over the positive
  coefficients, matching the invariant the design states, verified by a test
  over a synthetic matrix that carries controls with much larger coefficients
  than the reported columns.
- Re-running the fit against the production snapshot puts `geopolitics` above
  `physical_cb`, rather than the reverse.
- `jamasp weights fit` still produces Fit A unchanged — same 38 coefficients,
  same values — on the same snapshot.

## Related

- Found while fixing the map inversion in PR #35 (`panel/lib/marketmap.ts`).
- `docs/superpowers/specs/2026-08-20-market-maps-learning-loop-design.md`,
  §"From coefficients to multipliers" — the invariant this violates.
- `docs/superpowers/specs/2026-08-18-market-maps-design.md`, §"Negative
  coefficients — an explicit rule" — says a negative coefficient is evidence
  the *direction scoring* is wrong, "not that the theme should shrink", and
  then prescribes clamping to the floor, which shrinks it 4×. Four of six
  themes are currently negative, so that rule is what most of the map ran on.
  Worth resolving alongside this.
- `docs/todo/012` — why there was no fit at all before 2026-09-05.

## Resolution

Fixed in `jamasp/fit.py`. `to_multipliers` takes a new `report` argument — the
positions the caller will publish — and takes both the normalising mean and
the `negative:` flags over those columns only. `run_fit` computes `keep`
before the call and passes the matching indices. `report=None` (Fit A) keeps
the old population exactly, so Fit A is untouched by construction.

### Re-derived independently before fixing

Against a read-only copy of `/home/jamasp/Jamasp/state/jamasp.db` (20.4 MB,
copied 2026-09-06, `integrity_check` ok) and the host's `state/weights.json`
(`fitted_at 2026-09-05T23:37:55Z`). Every number in **Evidence** above
reproduces: 44 columns (6 themes + 38 controls), n=233, β̄ over all columns
`0.197015`, β̄ over theme columns `0.011758`, ratio **16.7553×**, largest
control |β| `fib50@4h` = 0.853719.

Two corrections to **Evidence**, neither changing the conclusion:

- The `theme-only` column's `physical_cb 0.2500` is the *pre-gate* normalised
  value. `physical_cb` has 16 observations against `min_observations: 50`, so
  `run_fit` overrides it with the unfitted neutral **1.0** whatever the
  normalisation does. After the fix it still ships **1.00**, not 0.25. The
  **Done when** ordering criterion is still met — geopolitics 1.7597 > 1.00 —
  but by geopolitics rising, not by physical_cb falling.
- Fit A was confirmed unaffected by running it through `run_fit` both before
  and after the fix: 38 coefficients, max |Δmultiplier| vs the shipped file
  **5.78e-12**, max |Δβ| **2.83e-11**, identical flag list. (Comparing against
  `to_multipliers` directly shows a spurious 0.75 gap on `net_spec@1d`, which
  has 0 observations and is gated to 1.0 by `run_fit`, not by the
  normalisation.)

### Corrected multipliers on the production snapshot

| theme | β | obs | fitted | was | now |
|---|---|---|---|---|---|
| rates_dollar | −0.010628 | 211 | yes | 0.25 | 0.2500 |
| geopolitics | +0.020691 | 202 | yes | 0.25 | **1.7597** |
| physical_cb | +0.002825 | 16 | no | 1.00 | 1.0000 |
| etf_flows | −0.004961 | 3 | no | 1.00 | 1.0000 |
| supply_mining | −0.015962 | 67 | yes | 0.25 | 0.2500 |
| other | −0.002437 | 146 | yes | 0.25 | 0.2500 |

The theme fit's `flags` list drops from 20 entries to 4 — the four genuine
theme negatives — with all 16 technical control columns gone. That closes the
second half of the **Fix** section: `.claude/skills/retro/SKILL.md` tells the
retro to "walk the **`theme`** fit's `flags`", and that instruction is now
unambiguous without editing the skill.

### `min_observations` default: left at 1.0, deliberately

An unfitted column still renders 1.0. That is not a leftover — after the fix
it is the *correct* neutral, because the reported positive multipliers average
exactly 1.0 before clamping, so 1.0 is the centre of the measured population.
It looked wrong only because the broken normalisation compressed every fitted
theme onto the 0.25 floor, leaving 1.0 four times the largest measurement.
Changing it would also change Fit A, where 1.0 already sits correctly inside a
0.25–3.0 spread (`net_spec@1d`, 0 observations). Recorded as a comment in
`run_fit` so the coupling between the two is not rediscovered by accident.

The residue — an unfitted theme at 1.0 outranking four *measured* themes at
0.25 — is not caused by `min_observations`. It is the negative-coefficient
clamp named in **Related**, which shrinks a column 4× for a defect the spec
says is about direction scoring. That question is unchanged by this fix and
still belongs to the retro.

### The two stored fits

`weight_fits` keeps `2026-09-05T21:33:46Z` and `2026-09-05T23:37:55Z` for both
`technical` and `theme`. The **theme** rows of those two stamps are the only
ones ever written under the old normalisation; the technical rows are correct.
They were left in place — `weight_fits` is the trajectory table, and deleting
rows would leave a future reader with multipliers that jumped for no recorded
reason. `state/weights.json`, which is the only file anything reads, was
corrected by re-running the fit after deploy.

### Done when — checked

- Published theme positives average 1.0 before clamping: covered by
  `test_the_normalising_mean_ignores_columns_the_fit_will_not_report`, whose
  synthetic matrix carries a control 60× the reported columns.
- Production snapshot puts geopolitics (1.7597) above physical_cb (1.0000).
- Fit A unchanged on the same snapshot: 38 coefficients, max |Δ| 5.78e-12.
- Full suite: 504 passed, 4 skipped.
