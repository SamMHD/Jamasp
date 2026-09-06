---
id: 016
title: Fit B normalises theme multipliers against the control columns, so they land 17x too low and in the wrong order
status: open
opened: 2026-09-06
owner: unassigned
closed:
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
