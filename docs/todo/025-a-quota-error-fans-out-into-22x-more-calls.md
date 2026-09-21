---
id: 025
title: A translator quota error fans out into 22x more calls instead of stopping the run
status: open
opened: 2026-09-21
owner: unassigned
closed:
---

## Problem

`_batch_with_fallback` treats every failure the same way: retry the batch once,
then issue one call per row. A failing batch of 20 therefore costs **22 calls
instead of 1**.

That is the right trade when one bad headline would otherwise poison nineteen
good ones. It is exactly the wrong trade when the failure is *"you are out of
quota"*, because then every batch fails, every batch fans out, and the fan-out
is what deepens the exhaustion that caused it.

`jamasp/modelrun.py` cannot tell the two apart. Both arrive as a non-zero exit
and become `ModelError`:

```
translator exit 1: ERROR: You've hit your usage limit.
  Upgrade to Pro (…), visit …/codex/settings/usage to purchase more
  credits or try again at 10:00 PM.
```

## What it cost

Observed on the live host after the timer was enabled against a ~2,800-item
backlog:

- 160 runs
- 1,861 items driven to `fa_attempts = 3` and abandoned, every one of them
  carrying a usage-limit error rather than a translation failure
- three separate quota-reset times visible in the recorded errors (1:13 PM,
  5:00 PM, 10:00 PM) — it exhausted the allowance, waited, and exhausted it
  again

A healthy tick is 12 batch calls. A tick where every batch fails is
12 × 22 = 264. The whole-branch review of the original PR computed the
worst case at roughly 38,000 calls/day and flagged the 22-call fallback; the
cost was read as bounded per batch, and the case where the failure is *caused
by volume* — so that it triggers on every batch at once — was not connected to
it.

Note the second cost, which outlives the quota window: those 1,861 rows are
not merely untranslated, they are *abandoned*. Nothing retries a row at the
cap. They need `jamasp translate --force` to come back, and a `--force` run
issued while the quota is still short would re-burn in exactly the same shape.

## Why the floor is not the fix

`translate.translate_from` (commit `5fd2ca2`) stops the job reaching back into
history, which removes the 2,800-row trigger. It does not remove the trap: at
roughly 250 items a day the pass still runs ~13 batches, and a quota shortfall
still turns those 13 calls into ~286 and still abandons the day's news. The
blast radius is two orders smaller; the mechanism is untouched.

## What to do

Give `jamasp/modelrun.py` a distinct exception for quota exhaustion — match the
usage-limit signature on stderr — and have `jamasp/translate.py` treat it
differently from `ModelError`:

- **abort the pass immediately** rather than falling back to singles, since
  every subsequent call will fail the same way
- **do not increment `fa_attempts`**, because the row is not the problem and
  abandoning the whole window over a billing state is the worst outcome here
- record it somewhere an operator sees — the run's summary line, and ideally a
  watchdog probe distinct from the backlog one, so "out of quota" reads
  differently from "translation is broken"

The reset time is in the error text (`try again at 10:00 PM`). Parsing it to
skip ticks until then would be better still, but stopping the fan-out is the
part that matters.
