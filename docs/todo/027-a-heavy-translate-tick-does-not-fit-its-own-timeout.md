---
id: 027
title: A heavy translate tick needs more time than TimeoutStartSec allows, so systemd kills it part-way
status: open
opened: 2026-09-22
owner: unassigned
closed:
---

## Problem

`ops/systemd/jamasp-translate.service` sets `TimeoutStartSec=2400`. The
per-pass ceilings in `config/settings.yaml` can ask for more than that in a
single tick, and nothing reconciles the two. Each pass has its own cap and
none of them knows about the others:

| pass | cap | source |
|---|---|---|
| rows | 6 batches | `max_batches_per_run: 6` |
| events | 6 batches | `max_batches_per_run: 6` (same key) |
| documents | 10 calls | `max_doc_calls_per_run: 10` |

At `timeout_seconds: 180` that is 22 calls, 3,960 seconds — 65% over the
limit, before anything goes wrong.

## Why it matters

Past `TimeoutStartSec` systemd SIGTERMs the unit. The run is not slow, it is
gone, and a kill is not a clean stop:

- The document the run was in the middle of loses every chunk it had already
  paid for — `translate_document` writes its sidecar once, at the end.
- A kill records **no attempt** against that document: `DocLedger` counts
  `ModelError` and `ParseError`, and a SIGTERM is neither. So the next tick
  makes exactly the same choices and is killed at exactly the same place.
- `OnFailure=jamasp-alert@%n.service` fires, so a heavy-but-healthy tick
  pages the desk.

Two things make the over-run larger than the table above:

- A batch the translator refuses retries once and then falls out to one call
  per row (`_batch_with_fallback`): one bad batch of 20 costs 22 calls, not
  1. That fan-out is the mechanism `docs/todo/025` measured at 1,861 rows
  driven to the attempt cap.
- One document per tick that needs more chunks than the whole document
  ceiling is let through regardless (`translate.DocBudget.take`, which
  explains why). Every `## ` section is at least one chunk, so a report with
  30 short sections is 31 calls on its own.

## Evidence

Checked 2026-09-22 on `fix/translate-large-documents`.

- `config/settings.yaml`: `timeout_seconds: 180`, `batch_size: 20`,
  `max_batches_per_run: 6`, `max_doc_calls_per_run: 10`,
  `doc_chunk_bytes: 8000`.
- `ops/systemd/jamasp-translate.service`: `TimeoutStartSec=2400`. Its comment
  used to claim "10 calls at 180 each is 30 minutes… 40 minutes is that with
  slack", which counted the document pass only; `config/settings.yaml`
  repeated the same arithmetic. Both now state the real worst case, which is
  how this item was found.
- `jamasp/translate.py` `run_translate`: rows, then events, then documents,
  each with its own ceiling, no shared clock and no wall-clock check.
- NOT measured on the live host: the timer is disabled there pending this
  branch, so 3,960 seconds is arithmetic from the configured caps, not an
  observed run. The observed numbers that do exist are the per-document ones
  in `DEFAULT_CHUNK_BYTES`'s comment.

## Fix

Options, roughly in increasing order of work:

1. Raise `TimeoutStartSec` to cover the arithmetic worst case (say 4,800) and
   accept that a wedged run holds the 10-minute timer for over an hour.
2. Lower the caps so the arithmetic fits — but the document ceiling is
   already the thing that makes a heavy day converge over two ticks rather
   than one, and lowering it further slows recovery after an outage.
3. Give the run a wall-clock deadline it checks between calls, sized from
   `TimeoutStartSec` with slack, and stop cleanly when it is reached —
   recording the stop the way a budget deferral is recorded, so the next tick
   resumes rather than repeating. This is the only option that also covers
   the fan-out and the oversized-document hatch, neither of which any
   per-pass call count can bound.

Option 3 wants `DocBudget` and the batch loop to share one object.

## Done when

A tick that would exceed the unit's start timeout stops itself cleanly and
says so in the run summary, proven by a test with a fake clock, and the unit
no longer depends on systemd killing it. Or: the caps and the timeout are
reconciled on paper and a test asserts the arithmetic, if the wall-clock
option is judged not worth it.

## Related

- `docs/todo/025` — the quota fan-out, closed; the fan-out on an ORDINARY
  failure is still 22 calls per bad batch and is part of this over-run.
- `docs/todo/019` — the document attempt cap, and `DocBudget`, which bounds
  the document pass but not the tick.
- `ops/systemd/jamasp-translate.service` — the comment that now names this
  item rather than claiming the work fits.
