---
id: 006
title: CFTC net_spec is stamped by report date (Tuesday), not release date (Friday) — a ~3-day lookahead in the learning loop
status: open
opened: 2026-08-22
owner: unassigned
closed:
---

## Problem

`jamasp/ingest/prices.py`'s `parse_cftc_cot_json` stamps the CFTC COT
net-speculative series (`GC_NET_SPEC`) with the report's `AS OF` date, not
the date the number was actually published:

```python
ts = f"{rec['report_date_as_yyyy_mm_dd'][:10]}T00:00:00Z"
return "GC_NET_SPEC", ts, net
```

`config/sources.yaml`'s own comment on the source already states the
schedule plainly: "weekly net non-commercial (speculative) positioning in
the main 100-oz COMEX contract, **released Fridays with data through
Tuesday**." So `report_date_as_yyyy_mm_dd` is the Tuesday the positioning
data is *as of*; the CFTC does not publish it until the following Friday —
roughly a three-day gap.

`jamasp/signals.py`'s `series_states` — the function `net_spec` is fed
through, identically to `gvz` — documents an assumption that is true for one
of its two callers and false for the other:

```python
def series_states(name: str, points: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """States for an external `prices` series: (ts, value) in, (ts, state) out.

    These carry no bar structure, so their timestamp IS their observation
    time — there is no open/close distinction to get wrong.
    """
```

For `gvz` (`^GVZ`, a Yahoo close) the stamped `ts` genuinely is the
observation time. For `net_spec` it is not: the stamped Tuesday is three
days earlier than the Friday the value actually became public.

## Why it matters

The learning loop's whole no-lookahead guarantee (`jamasp/features.py`'s
module docstring: "a signal's state enters row t only if the bar it came
from had already CLOSED by t") rests on every stamped timestamp being a
genuine observation time. `features.as_of` looks up "the latest value
observed at or before `ts`" — for `net_spec@1d`, that lookup will find and
use a Tuesday's positioning number for any training row timestamped that
same Tuesday, three days before the number was actually knowable. Every
hourly row between the Tuesday report date and the following Friday release
sees positioning data it could not have seen in real time — a genuine
lookahead leak into both Fit A (`net_spec@1d` is one of the 38 technical
columns) and Fit B (via the same technical columns, used there as controls).

This is a smaller, slower-moving version of the exact class of error
`features.py`'s "NO LOOKAHEAD" section exists to prevent, sitting in the one
column of the 38 where the stamping convention documented as universal
(`series_states`'s docstring) does not actually hold.

## Evidence

Checked 2026-08-22, from this worktree
(`/Users/saman/Rabin/Jamasp/.worktrees/market-maps-learning`), by reading
rather than asserting:

- `jamasp/ingest/prices.py:88-89` — `parse_cftc_cot_json` stamps `ts` from
  `rec['report_date_as_yyyy_mm_dd']`, the report's `AS OF` field in the CFTC
  Socrata API, not any field carrying a publication/release timestamp.
- `config/sources.yaml:255-258` — the source's own comment: "released
  Fridays with data through Tuesday," confirming the ~3-day gap between the
  stamped date and public availability from CFTC's own publication cadence
  (this is the CFTC's standing schedule, not something re-verified against
  a live fetch in this sitting).
- `jamasp/signals.py:171-176` — `series_states`'s docstring claims "their
  timestamp IS their observation time" for every caller uniformly; `gvz` and
  `net_spec` are its only two callers (`config/weights.yaml:54-55`,
  `source: price_series`), and the claim holds for one and not the other.
- `jamasp/features.py:50-66` (`as_of`) and its module docstring's
  "NO LOOKAHEAD" section state the guarantee this timestamp choice violates
  for `net_spec` specifically.
- Not fixed in this pass: Finding 5's fix (the market-maps-learning-loop
  Important-findings wave, 2026-08-22) explicitly named this as an
  out-of-scope item — "dormant until ~mid-2027" per the task brief, i.e. the
  fit will not have enough net_spec history to weight it meaningfully for
  some time yet, so the lookahead is real but not yet operationally live.

## Fix

Shift `net_spec`'s stamped timestamp forward to (an estimate of) its actual
release time rather than its `AS OF` date — e.g. `report_date + 3 days`
stamped at CFTC's known Friday 15:30 ET release time, or a more precise
value read from the API if one is available (the Socrata dataset may carry
a separate publication-date field worth checking). Once shifted correctly,
either drop `series_states`'s "no open/close distinction to get wrong" claim
(it is caller-dependent, not universal) or add the same close/open framing
`bar_states` already uses for bar-sourced signals, so a future third
`price_series` source doesn't inherit the same false assumption by copying
the docstring at face value.

## Done when

`parse_cftc_cot_json` (or a wrapping step in `jamasp/signals.py`) stamps
`GC_NET_SPEC` observations at their actual public-availability time, not
their `AS OF` date, and `series_states`'s docstring no longer claims a
property that is false for one of its two current callers — either by
carving out the caller-specific claim explicitly, or by fixing the
timestamp so the claim becomes true again for both.

## Related

- Finding 5, market-maps-learning-loop Important-findings fix wave
  (`.superpowers/sdd/2026-08-20-market-maps-learning-loop/final-fix-report.md`,
  2026-08-22) — named this gap explicitly as out of scope for that pass and
  pointed here.
- `docs/superpowers/specs/2026-08-20-market-maps-learning-loop-design.md` —
  the design this timestamp assumption underpins.
