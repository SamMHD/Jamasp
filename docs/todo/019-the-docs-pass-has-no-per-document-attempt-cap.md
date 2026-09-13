---
id: 019
title: The docs pass has no per-document attempt cap, so a permanently refused document costs a call every tick forever
status: open
opened: 2026-09-13
owner: unassigned
closed:
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
