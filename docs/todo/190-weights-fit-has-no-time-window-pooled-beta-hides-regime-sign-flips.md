---
id: 190
title: "`jamasp weights fit` has no time window — the pooled theme β hides a September-only sign inversion on rates_dollar, and reports no intercept"
status: open
opened: 2026-09-27
owner: unassigned
closed:
---

## Problem

`jamasp weights fit` (`jamasp/cli.py` `weights_fit`, `jamasp/fit.py`
`fit_all`) takes `--symbol` and `--out` only. Every fit is a full refit
over all history, and `state/weights.json` reports one β per column. The
retro's §4.6 job is to read the theme fit's `negative:` flags as evidence
that a theme's *direction scoring* is wrong — but a regime-local sign flip
inside a pooled sample never reaches the flag, because the months average
out.

Checked 2026-09-27 (retro) by replicating the exposure column by hand —
hourly Σ(direction × tier_weight) from `item_scores` joined to `items`,
against the 24h-forward GC return from `prices` rows, split by month:

| theme | month | net-bullish hours | net-bearish hours |
|---|---|---|---|
| geopolitics | Aug | n=86, mean −0.01% | n=34, mean −0.49% |
| geopolitics | Sep | n=244, mean −0.00% | n=52, mean −0.09% (median −0.28%) |
| rates_dollar | Aug | n=62, mean −0.04% | n=58, mean −0.39% |
| rates_dollar | **Sep** | n=99, **mean −0.21%** | n=181, **mean +0.17%** |

`rates_dollar` is right-sign in August and inverted in September (~2.4σ
on the difference of means); the pooled β in `state/weights.json`
(26 Sep: +0.0246, se 0.0161, 1.5σ) flags nothing. The geopolitics β
(+2.4σ) turned out to be the bearish-scored hours being followed by gold
DOWN rather than bullish hours being followed by gold UP — a reading the
fit output cannot give either, because the intercept and the per-sign
conditional means are not reported.

## Why it matters

- The retro skill's §4.6 promises that the theme fit's flags are "the
  single most useful thing the regression can report". They are only that
  if the regression can see a regime. The Sep 2026 regime (oil → 2y → DXY
  → gold; 15 oil-UP sessions with gold flat/down) is exactly the kind of
  thing a pooled 60-day fit averages away.
- The likelier mechanism for the Sep inversion is relay lag — a
  rates_dollar item is scored bearish because it *reports* "gold falls as
  yields rise" and is published after the move, so the 24h-forward window
  catches the retrace — which is a property of fitting a reporting feed at
  24h, not a scorer defect. Distinguishing the two needs a windowed fit
  and a shorter horizon side by side, neither of which the CLI offers.
- The 20 Sep retro deliberately did not file this ("a curiosity until the
  sign persists"). The sign persisted, and the second finding appeared
  only because the retro hand-rolled the split. That is not a sustainable
  way to read the fit weekly.

## Fix

Smallest useful change:

1. `jamasp weights fit --since <ISO>` (and/or `--window-days N`): restrict
   the training rows to `ts >= since`; refuse below `fit.min_rows` as now.
   Write to `--out` as today so a retro can produce `state/weights-30d.json`
   beside the daily file without touching the map.
2. In the theme fit's output, add per column: `mean_fwd_bull`,
   `mean_fwd_bear`, `n_bull`, `n_bear` (conditional means of the target on
   the sign of the exposure), and the fit's `intercept`. This is what
   turns "β positive" into "bullish hours up" vs "bearish hours down".
3. Optionally `--horizon-hours` as a CLI override so the retro can compare
   24h against 4h without editing `config/weights.yaml`.

Not proposed: pinning `rates_dollar` on this evidence. A pin would encode
one month's retrace into the map.

## Done when

- `uv run jamasp weights fit --since 2026-09-01 --out /tmp/w.json` runs and
  reports a smaller `n` than the unwindowed fit.
- The theme fit's JSON carries the conditional means and intercept per
  column, and the retro skill's §4.6 text tells the retro to read them.
- The next retro can state, from the tool alone, whether a flagged or >2σ
  theme is driven by its bullish-scored or its bearish-scored hours.

## Related

- `.claude/skills/retro/SKILL.md` §4.6.
- `reports/2026/09/2026-09-20-retro.md` and `2026-09-27-retro.md`, Weight
  fits sections.
- `docs/todo/004` — theme vocabularies; `docs/todo/016` — Fit B
  normalisation.
