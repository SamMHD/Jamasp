---
id: 025
title: A translator quota error fans out into 22x more calls instead of stopping the run
status: done
opened: 2026-09-21
owner: unassigned
closed: 2026-09-22
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

## Resolution

Fixed across `jamasp/modelrun.py`, `jamasp/translate.py` and `jamasp/cli.py`.

- `modelrun.QuotaExhausted(ModelError)` is raised from `run_json` when a
  non-zero exit's stderr/stdout matches `_is_quota_exhausted`: "usage limit"
  paired with "credit" or "upgrade" — the billing-specific phrasing, not the
  whole sentence, so a reworded reset time or URL still trips it without an
  ordinary refusal doing so by accident.
- `_batch_with_fallback` (used by both the rows and events passes) no longer
  catches `QuotaExhausted` in its retry/fallback logic — it re-raises
  immediately, before any retry and before the singles fallback, so a batch
  that hits quota costs exactly the 1 call that discovered it, not 22. The
  row/event is left completely untouched: `fa_attempts` and `fa_failed_at` are
  never written, because the write only happens after a batch actually
  returns (successfully or via the old fallback), and `QuotaExhausted` never
  reaches that point.
- The four document-sidecar functions (`translate_stance`,
  `translate_document`, `translate_watchlist`, `translate_predictions`) re-
  raise the same way instead of recording a per-item failure, and
  `translate_docs` wraps the whole chain (stance → playbook → watchlist →
  predictions → reports) in one try/except so a quota hit in any one of them
  stops the rest of the docs pass too.
- `run_translate` checks each pass's `quota_exhausted` flag and skips every
  later pass once one is set (rows → events → docs), so a quota hit anywhere
  aborts the *whole* run, not just the pass that found it.
- The CLI's `_translate_line` names the stop explicitly ("STOPPED on quota
  exhaustion, remaining passes skipped: <message>") instead of letting it read
  as `rows 0/0; events 0/0; docs 0/0` — indistinguishable from a quiet tick.
  `jamasp translate` then exits non-zero, which fires
  `jamasp-alert@jamasp-translate.service` — already wired on the unit and
  already rate-limited to once an hour per unit by `jamasp/alert.py`'s
  `should_send()`, so a multi-hour outage pages the desk once, not every
  10-minute tick.
- `tests/fake_codex.py` gained a `quota` mode that exits non-zero with the
  real production message (verbatim, modulo the reset time) so the signature
  match is exercised against real text end to end, not a paraphrase.

Not implemented: parsing the reset time out of the message to skip ticks
until then. Stopping the fan-out was the part that mattered; scheduling
around the reset is a reasonable follow-up but a separate change.

Tests: `tests/test_modelrun.py` (signature matching, both positive and
negative), `tests/test_translate.py` (call-count assertion that a 20-row
batch costs 1 call not 22, `fa_attempts`/`fa_failed_at` left untouched, the
ordinary-`ModelError` fallback regression-tested unchanged, cross-pass abort
for rows→events/docs and events→docs, and a docs-pass self-abort), and
`tests/test_cli.py` (summary line wording and an end-to-end CLI run through
the real `fake_codex.py` quota mode asserting a non-zero exit and an
untouched row).
