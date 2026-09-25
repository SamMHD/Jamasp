---
id: 026
title: No watchdog probe sees an abandoned document, so a permanently untranslatable one is silent
status: open
opened: 2026-09-22
owner: unassigned
closed:
---

## Problem

`docs/todo/019` gave the document pass an attempt cap: a unit that fails
`translate.MAX_DOC_ATTEMPTS` times stops being attempted and its row sits in
`doc_translations`. The cost bleed is stopped. Nothing tells the desk.

`jamasp/watchdog.py` carries two translate probes and both query `items` — a
backlog probe and an abandoned-row probe. Neither looks at documents, and
`doc_translations` did not exist when they were written.

## Why it matters

The run summary now says `docs 0/0 (3 abandoned after 3 failed attempts —
--force retries)`, which is only seen by someone reading the journal. The unit
exits zero, because an ordinary translation failure is deliberately not worth
paging over (see the comment on `jamasp-translate.service`'s `ExecStart`). On
the panel an abandoned document renders as English with an `EN` marker, which
is indistinguishable from "not translated yet".

So a document that will never be translated again without `--force` looks
exactly like one that is merely queued. The realistic trigger is content — a
single paragraph larger than `translate.doc_chunk_bytes` has no safe split
point and goes to the translator whole, which is precisely the shape that
timed out before chunking.

## Evidence

Checked 2026-09-22 on `fix/translate-large-documents`.

- `jamasp/watchdog.py` — grep for `fa_attempts` returns the abandoned-ROW
  probe only; grep for `doc_translations` returns nothing.
- `jamasp/translate.py` — `DocLedger.state()` returns `abandoned` and the
  count reaches `stats["docs"]["abandoned"]`, which `jamasp/cli.py`'s
  `_translate_line` prints and nothing else consumes.
- `translatetext.doc_segments` emits an over-limit chunk when a single
  paragraph exceeds the threshold, by design — so the failing shape survives
  the chunking fix and is bounded rather than eliminated.

## Fix

A probe alongside the existing translate probes: violate when
`doc_translations` holds any row at `attempts >= MAX_DOC_ATTEMPTS`, naming the
units and their `last_error`. Gate it on `meta.last_translate_at` the way the
other two are, so it stays quiet on a host where the timer has never run.

Decide whether the probe should ignore units whose source has since changed —
`state()` treats a hash change as new work, but the stale row survives until
the unit next succeeds or fails, so a naive count can name a unit that is no
longer abandoned. Either compare the row's `src_hash` against the file, or
have the ledger delete a row it finds stale.

## Done when

A document driven to the cap produces a watchdog violation naming it, proven
by a test, and the violation clears once the document translates or `--force`
re-arms it.

## Related

- `docs/todo/019` — the cap itself, and its Resolution, which records this as
  the part that did not ship.
- `jamasp/db.py` — the `doc_translations` table and the argument for it.
