---
id: 004
title: Decide and rollup now speak two different theme vocabularies
status: open
opened: 2026-08-19
owner: unassigned
closed:
---

## Problem

Two different model calls in `jamasp/flashtext.py` each produce a `theme`
value, and they are no longer on the same vocabulary:

- The **decide** call (`build_decide_prompt` / `parse_decide_response` /
  `_theme`) now asks for a `theme` from `config/weights.yaml`'s six-slot
  taxonomy: `rates_dollar`, `geopolitics`, `physical_cb`, `etf_flows`,
  `supply_mining`, `other`. `_theme()` falls back to `"other"` for anything
  not in that list, and this is what gets written to `item_scores.theme`.
- The pre-existing **rollup** call (`build_rollup_prompt` /
  `parse_rollup_response` / `render_rollup`) groups held items under
  `ROLLUP_THEMES`, a four-key dict: `rates_dollar`, `geopolitics`,
  `metals_mining`, `other`. `metals_mining` is not on the new six-slot list
  at all, and the new list's `physical_cb`, `etf_flows`, `supply_mining`
  have no entry in `ROLLUP_THEMES`.

## Why it matters

`render_rollup` looks up each group's Persian header with
`ROLLUP_THEMES.get(theme, ROLLUP_THEMES["other"])` (`jamasp/flashtext.py:402`).
Any theme the rollup model names that isn't one of the three specific
`ROLLUP_THEMES` keys collapses into the generic "سایر" (other) header — which
now includes `physical_cb`, `etf_flows` and `supply_mining` even when the
model correctly distinguished them. The channel-facing rollup a human reads
therefore groups more coarsely than the `item_scores` table the map is built
from: a story the scoring substrate correctly tagged `etf_flows` shows up in
the rollup under the same "سایر" heading as `geopolitics` misses and anything
else unclassifiable. The data isn't corrupted — `item_scores.theme` is
unaffected, since decide and rollup are independent calls writing to
independent places — but the two theme values a desk reader sees (map vs.
rollup) no longer describe the same taxonomy.

## Evidence

Checked 2026-08-19, by reading the code (not a live-response bug — this is a
static vocabulary mismatch):

- `config/weights.yaml`: `themes:` lists exactly `rates_dollar`,
  `geopolitics`, `physical_cb`, `etf_flows`, `supply_mining`, `other` — six
  slots, load-bearing for Plan 2's positional column indexing (see
  `jamasp/config.py`'s `themes()`).
- `jamasp/flashtext.py:326-331`: `ROLLUP_THEMES = {"rates_dollar": ...,
  "geopolitics": ..., "metals_mining": ..., "other": ...}` — a separate,
  hardcoded four-key dict, unchanged by this plan.
- `jamasp/flashtext.py:213-220` `_theme()`: validates against the
  `config_mod.themes()` six-slot list for the **decide** response only.
- `jamasp/flashtext.py:383`: the **rollup** response's theme is validated
  inline against `ROLLUP_THEMES` (`theme if theme in ROLLUP_THEMES else
  "other"`), a wholly separate check against a wholly separate vocabulary —
  the rollup prompt/parser was never touched by this plan.
- No test in `tests/test_flash.py` or `tests/test_flashtext.py` currently
  asserts the two vocabularies agree; none would fail today.

## Fix

Ruled **out of scope** for this plan: unifying the two vocabularies would
change channel-rollup grouping behaviour (either dropping the existing
`metals_mining` bucket or remapping it, and deciding how the rollup should
now split — or not split — `physical_cb`/`etf_flows`/`supply_mining`), which
is a product decision, not a side effect that should ride along with the
scoring substrate. Recording it here so it isn't lost between plans.

Candidates for whoever picks this up:

1. Make `ROLLUP_THEMES` a mirror of `config/weights.yaml`'s six themes, each
   with its own Persian label, retiring `metals_mining` as a bucket (its
   stories would land in whichever of the six slots the decide model would
   have assigned them).
2. Keep the two vocabularies deliberately separate, but say so explicitly in
   `jamasp/flashtext.py` next to `ROLLUP_THEMES` — a comment stating it is
   intentionally a coarser, rollup-only display grouping distinct from the
   `item_scores` taxonomy, so the next reader doesn't assume they're the
   same list.

## Done when

Either the two vocabularies are reconciled to one taxonomy (or an explicit,
tested mapping between them) and a test pins the reconciliation, or this is
closed `abandoned` with option 2's "intentionally separate" decision
recorded and the code comment in place.

## Related

- `config/weights.yaml` — the six-slot `themes:` list.
- `jamasp/flashtext.py` — `ROLLUP_THEMES`, `_theme()`, `parse_decide_response`,
  `build_rollup_prompt`, `parse_rollup_response`, `render_rollup`.
- `jamasp/config.py` — `themes()`.
- `docs/superpowers/plans/2026-08-18-market-maps-scoring-substrate.md` — the
  plan that introduced the six-slot decide taxonomy without touching the
  rollup's.
