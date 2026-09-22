---
id: 019
title: The docs pass has no per-document attempt cap, so a permanently refused document costs a call every tick forever
status: done
opened: 2026-09-13
owner: unassigned
closed: 2026-09-22
---

## Problem

Rows and events carry `fa_attempts` and are abandoned at `MAX_ATTEMPTS = 3`.
Documents carry nothing of the kind: a document whose translation fails is
retried on the next tick, and the one after, indefinitely. There is no
counter, no status, and nowhere to put one — the sidecar records only what
succeeded.

`a8e89f7` added `translate.max_doc_calls_per_run`, which bounds how much ONE
tick can spend. It does not bound the total: a document the translator always
refuses still costs a call on every tick that reaches it, ~144 a day, forever.

The watchdog cannot see this either. Its backlog and abandoned probes both
count rows in `items`; no probe looks at documents at all.

## Why it matters

It is an unbounded standing cost with no visible symptom. The panel shows the
document in English with an `EN` marker, which is indistinguishable from "not
translated yet", and the unit exits zero every time because a failed document
is a counted failure, not an error.

The realistic trigger is content, not infrastructure: one prediction claim or
one stance section that trips a refusal, or one report the translator will not
process. That is a per-document property, so it does not self-heal.

## Evidence

Checked 2026-09-13 on `feat/panel-i18n-translate` at `5e0d03c`.

- `jamasp/translate.py` — `translate_stance`, `translate_document`,
  `translate_watchlist` and `translate_predictions` each catch
  `(ModelError, ParseError)`, count a failure, and keep the previous content.
  Grep for `fa_attempts` returns hits only in the `items`/`events` paths;
  nothing per document.
- `translate_stance` deliberately preserves the section's OLD hash on failure
  ("so the next run tries again rather than believing it is done") — correct
  for a transient failure, and exactly the loop for a permanent one.
- `jamasp/watchdog.py` — both translate probes query `items`. No document
  probe exists.
- `a8e89f7` — `DocBudget` caps calls per run; `config/settings.yaml` sets
  `max_doc_calls_per_run: 10`. Per tick, not per document.
- **Not yet observed in the wild:** the translate timer has never been enabled
  on the host (`meta.last_translate_at` is what proves a run happened, and the
  watchdog now gates on it). This is a structural gap, not an incident.

## Fix

Needs a place to keep the count, since the sidecar only records successes.
Candidates, roughly in order of cost:

- A `doc_translations` table keyed by relative path, holding `src_hash`,
  `attempts`, `last_error`, `failed_at` — which would also give the docs pass
  the same backoff the rows pass got in `fed7ba1`, and give the watchdog
  something to probe.
- A `meta` key per document, which avoids a table but scales badly and reads
  as a hack the first time someone greps `meta`.

Whatever holds it, abandon at a cap the way rows do, clear it on `--force`
(the spec's escape hatch is meant to cover exactly this), and add a watchdog
probe so an abandoned document is as loud as an abandoned row.

## Done when

A document the translator always refuses stops costing model calls after a
bounded number of attempts, proven by a test that fails a document repeatedly
and asserts the call count stops growing — and the desk is told, via a
watchdog violation, rather than the document quietly staying English.

## Related

- `docs/superpowers/specs/2026-09-13-panel-i18n-translate-design.md` — Error
  handling, "Per-document", which stops at "records the failure".
- `a8e89f7` — the per-run ceiling that bounds the blast radius but not the
  lifetime cost.

## Resolution

Closed 2026-09-22 on `fix/translate-large-documents`, alongside the fix for
the large-document timeout that made this gap urgent: with every pending
report over the size the translator could swallow, the missing cap was no
longer theoretical — each unusable report cost a call per tick and the timer
was switched off because of it.

**What shipped**

- `doc_translations` (`jamasp/db.py`) — one row per unit that is CURRENTLY
  failing: `unit`, `src_hash`, `attempts`, `last_error`, `failed_at`. This is
  the first candidate from **Fix** above. The `meta`-key alternative was
  rejected for the reason named there and one more: reports arrive daily and
  never change, so `meta` would accumulate a key per broken report forever and
  make reading the table whole — its only real use — useless.
- `translate.DocLedger` — `state()` returns `ready` / `backoff` / `abandoned`
  for a unit, `record_failure()` counts one, `clear()` forgets a unit that
  succeeded, `clear_all()` is `--force`'s document half.
- `MAX_DOC_ATTEMPTS = 3`, and the ledger reuses the rows pass's
  `BACKOFF_MINUTES` — attempts land at t+0, t+15, t+75 rather than three
  ten-minute ticks walking a unit to the cap 20 minutes into a transient
  outage. That is the `fed7ba1` backoff this item asked for.
- A "unit" is the smallest thing translated in one decision: a whole report or
  playbook, but ONE stance section, one watchlist theme, one prediction line —
  so one refused section cannot abandon the other five.
- The counter is tied to the English it was earned against. `stance.md` is
  rewritten at the end of every agent run, and an abandonment that outlived
  its text would freeze a section in English for good.
- A quota error still records nothing: it is not the document's fault, and
  counting it would walk every unit to the cap during an outage (docs/todo/025).
- The run summary reports `abandoned` separately from `failed`, so "3
  documents are being skipped because they keep failing" no longer reads as "3
  documents failed this run".

**How Done when was checked**

`test_a_document_that_keeps_failing_stops_being_attempted` drives five ticks
across 400 simulated minutes at a translator that always refuses, and asserts
the call count stops at `MAX_DOC_ATTEMPTS`. `test_every_document_kind_is_
bounded_by_the_cap` proves the same for a stance section, a watchlist theme, a
prediction line, the playbook and a report together.
`test_run_translate_wires_the_document_ledger` proves it through the
production entry point rather than only through `translate_docs`.
`test_force_re_arms_an_abandoned_document` and
`test_rewriting_an_abandoned_document_re_arms_it` cover the two ways back out.

**What did NOT ship**

The watchdog probe. This item's **Done when** also asked that the desk be told
via a watchdog violation; `jamasp/watchdog.py` still has no document probe,
so an abandoned document is visible in the run summary and in
`SELECT * FROM doc_translations`, but nothing pages anyone. Filed separately
as `docs/todo/026`, because it is a watchdog change rather than a translate
one and the cost bleed — the thing that made this urgent — is stopped either
way.

## Amendment, 2026-09-22 (review of the shipping commit)

A review of `d977c72` found the cap as shipped could abandon every document
permanently: a 3-hour `ModelError` outage walks all seven units to
`attempts = 3`, and 24 hours of healthy ticks afterwards translate nothing —
measured at `{'translated': 0, 'failed': 0, 'abandoned': 7}`. `--force` was
the only way back, and `docs/todo/026` is open, so nothing pages anyone.
Before this item shipped, that scenario self-healed.

Fixed on the same branch, and the shape above is now the tested one:

- **Success re-arms.** `DocLedger.rearm_abandoned` drops every row at the cap
  once anything in the pass has translated — a working translator is evidence
  the abandonments were environmental.
- **Time re-arms.** `DOC_RETRY_AFTER_HOURS = 24`: a row at the cap whose last
  failure is older than a day gets one more attempt regardless. This is what
  breaks the deadlock when *every* unit is abandoned and no success can
  occur. Cost is one call per unit per day, measured from the last failure.
- **Orphans are pruned.** `DocLedger.prune_unseen` drops rows for units a
  completed pass did not find, so a watchlist theme dropped from
  `watchlist.yaml` no longer leaves a row behind forever.
- **`--force` clears before the rows pass**, so a quota stop in rows cannot
  swallow the recovery.
- **`translate --check` now asks the translator to answer** (`translate.probe`)
  rather than only checking the binary is on PATH. An unauthenticated `codex`
  is still a `codex` on PATH, and it is what produces the outage above.
- **`backoff` is counted and reported** alongside `abandoned`.
