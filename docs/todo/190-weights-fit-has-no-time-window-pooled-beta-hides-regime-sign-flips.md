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

## Update 2026-10-04 (retro)

4 Oct retro re-ran the split with the weighting recorded this time: hourly net exposure = Σ direction × (4 − tier) per theme, `item_scores` joined to `items` on `published_at`, 24h-forward GC return from `prices` (first GC row ≥ hour, first row ≥ hour+24h, ≤6h tolerance). geopolitics: Aug bull n=66 +0.14% / bear n=39 −0.54%; Sep bull n=242 −0.12% / bear n=87 −0.01%; Oct n=11 +0.11% / n=3 −0.45%. rates_dollar: Aug n=52 −0.19% / n=47 −0.18%; Sep n=101 −0.20% / n=193 −0.02%; Oct n=4 −0.23% / n=9 −0.04%. The September rates_dollar inversion persists (~1.2σ); the 27 Sep table used an unrecorded weighting so the two retros' numbers are not comparable — the case for the split living in `jamasp weights fit` rather than in a retro's ad-hoc script. Pooled fit 3 Oct 23:30Z: rates_dollar β +0.038 (2.5σ), geopolitics +0.030 (2.0σ), flags `negative:other` only (0.8σ).

## Update 2026-10-11 (make-up retro)

Same weighting as the 4 Oct update, so the rows compare. Aug and Sep rows
unchanged. **Oct:** geopolitics bull n=72 +0.25% / bear n=20 +0.04%
(ordered correctly); rates_dollar bull n=27 **−0.14%** / bear n=48
**+0.43%** — inverted for the second month running, spread 0.57% vs 0.18%
in September. Pooled fit 10 Oct 23:31Z: geopolitics β +0.037 (2.5σ),
rates_dollar +0.032 (2.1σ), flags `negative:physical_cb` (0.6σ, n=49,
unfitted) and `negative:other` (1.0σ). The relay-lag reading (rates items
scored bearish because they report "gold falls as yields rise", after the
move) now has two months behind it; the pooled β stays positive on August
and the intercept. Still no pin or scorer change — the split has no
standard error. If the November row inverts too, the rates_dollar
direction scorer becomes its own todo.

## Update 2026-10-18 (retro)

Pooled fit 17 Oct 23:35Z (n=817): rates_dollar β +0.0356 (2.6σ, back on
top), geopolitics +0.0273 (1.9σ); flags `negative:physical_cb` (−0.0078,
0.6σ, n=56 — first fit past `min_observations`, so the floor clamp 0.25
now applies; pinned to 1.0 until 15 Nov by this retro) and
`negative:other` (−0.0097, 0.7σ). Per-month split re-run on today's DB
(same weighting; Aug/Sep rows shift slightly because the scored set has
grown): rates_dollar Oct bull n=58 −0.08% / bear n=88 +0.29% — inverted
for the second month, spread 0.37% (0.57% on 11 Oct's n=75); by half-month
1–11 Oct bear +0.37 / bull −0.08, 12–18 Oct bear +0.18 / bull −0.07. Sep
bull −0.18 / bear −0.01 stands. The relay-lag reading holds on three
samples now; still no scorer change — the November row is the trigger
named on 11 Oct.

## Update 2026-10-25 (retro)

Pooled fit 24 Oct 23:38Z (n=915): rates_dollar β +0.0393 (se 0.0132,
**3.0σ**, multiplier 1.23 — down from 1.47 as the normalisation compressed
the columns), geopolitics +0.0287 (2.1σ, 0.90). Flags
`negative:physical_cb` (−0.0086, 0.7σ, n=57, pinned 1.0 to 15 Nov),
`negative:supply_mining` (**new**: −0.0009, 0.07σ, n=285 — the multiplier
was already at the 0.25 floor on last week's +0.0052, so the sign flip
changed the flag and nothing on the map) and `negative:other` (−0.0148,
1.1σ). Per-month split re-run, same weighting: rates_dollar Oct bull n=82
−0.47% / bear n=118 −0.04% (ordering still inverted, spread 0.43%); by
week — 1–11 Oct bull −0.16 / bear +0.43; 12–18 Oct −0.09 / +0.18;
**19–25 Oct −1.07 / −0.94** — the third row is the −4.1% week, every hour's
forward return negative whichever way the item was scored, so it says
nothing about direction. geopolitics Oct bull n=218 −0.23% / bear n=37
−0.34%. Still no scorer change; the November row stays the trigger. The
19–25 Oct row is also an argument for the conditional means carrying a
trend-adjusted (demeaned-by-day) variant, else any trending week swamps
the sign.

## Update 2026-11-01 (retro)

31 Oct 23:40Z fit, theme n=1013 (915 last week), 24h horizon. rates_dollar β +0.0271 (se 0.0136, 2.0σ, n=936) multiplier 0.91 (1.23 on 24 Oct, 1.47 on 17 Oct); geopolitics +0.0332 (2.3σ, n=941) multiplier 1.11 (0.90); other −0.0250 (1.85σ, n=718) 0.25; supply_mining −0.0089 (0.7σ, n=323) 0.25; physical_cb −0.0065 (0.5σ, n=59) pinned 1.0; etf_flows n=20 unfitted. Flags unchanged (negative:physical_cb / supply_mining / other). The two live columns swapped order on one −3% week — the rates_dollar items of the FOMC/PCE week were scored bullish into Friday's −146 settle. Per-month split re-run (hourly net exposure Σ direction×(4−tier), 24h-forward GC return, ≤6h tolerance): rates_dollar Oct bull n=100 −0.43% / bear n=178 −0.17% (ordering still inverted); geopolitics Oct bull n=297 −0.26% / bear n=54 −0.29% (no separation); ISO week 44 rates bull −0.63 / bear −0.45, geo −0.46 / −0.34 — a trend week again, both signs negative. No scorer change; the November row remains the trigger; the demeaned-by-day variant ask stands.

## Update 2026-11-08 (retro)

7 Nov 23:33Z fit, theme n=1110. rates_dollar β +0.0278 (se 0.0144, 1.9σ, n=1020) multiplier **1.44** (0.91 on 1 Nov, 1.23 on 24 Oct); geopolitics +0.0143 (1.0σ, n=1033) 0.74 (1.11); physical_cb **+0.0117** (0.8σ, n=63) — the `negative:` flag is gone, pin renewed to 13 Dec; supply_mining −0.0106 and other −0.0120 at the floor. The two live columns swapped order back on a +5% gold week — the pooled 24h fit follows the week's trend whichever column was busiest. Per-week split re-run (same method, reproduces the October rows): **wk 45 (2–8 Nov) rates_dollar bull n=33 +0.61% / bear n=26 +0.44%** — the November row named as the trigger does NOT invert (first correctly ordered week since wk 40), but it is a trend week like wks 43–44 the other way. No scorer change; the demeaned-by-day variant is still the only read that separates relay-lag from trend.
