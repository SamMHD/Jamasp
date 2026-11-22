---
id: 208
title: "Predictions carry no family field — family records (\"GC bands 28/28\") are hand-carried in claim text and drift"
status: open
opened: 2026-11-22
owner: unassigned
closed:
---

## What happened

Retro 2026-11-22. `state/predictions.jsonl` rows have `id, date, claim,
direction, horizon_days, confidence, created_at, outcome, scored_at, note`
— no family or tag. Every family record the playbook and the briefs rely on
is typed by hand into the next claim's text and into playbook evidence
lines. This week's band claims show the drift:

- `bc307866` (written 16 Nov): "GC bands 27/27"
- `64d07935` (written 17 Nov): "GC bands 28/28"
- `2708a4f8` (written 20 Nov): "GC band family 26/26" — three behind
- `a634395d` (written 21 Nov): "GC bands 28/28" — with 29 or 30 scored,
  depending on whether the reopen band `61f8fc55` counts as a GC band

The last line is the second problem: membership is undefined, so two runs
can both be "right".

## Why it matters

Playbook rules 5, 10, 12 and 20 set a claim's confidence from the family's
lifetime record ("0.55 is for families under 70%", "class negatives
34/36"). A hand-carried count that is off feeds straight into the stated
probability, and the retro cannot recompute hit rate by claim type without
re-reading every claim text.

## Suggested fix

- `jamasp predictions add --family <slug>` (free-form slug, stored on the
  row; optional so old rows stay valid).
- `jamasp predictions stats [--by family]` printing hits / misses / unclear
  and the stated-vs-observed gap per family and per confidence bucket.
- One-off backfill of the ~300 existing rows by slug (a dev session with a
  subagent reading claim texts), reviewed before commit.

## Evidence

Rows quoted above are in `state/predictions.jsonl` as of commit
`jamasp: retro 2026-11-22`. Playbook rule 13 now tells runs to count from
the file until this exists.
