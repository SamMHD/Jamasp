---
id: 017
title: A lede that arrives after its headline was translated is never translated, and nothing can see it
status: open
opened: 2026-09-13
owner: unassigned
closed:
---

## Problem

`items.lede` is not written at ingest. `jamasp/digest.py` fills it in a
separate Haiku pass at the end of the ingest tick, capped at
`digest.batch_max_items` (60) and skipped entirely when that pass fails.

`jamasp translate` selects rows with `pending_rows`, whose filter is
`headline_fa IS NULL`. So when the translate timer (10 minutes) beats the
ingest retry (15 minutes) to a row whose lede has not landed yet, it
translates the headline alone, writes `headline_fa`, and that row is never
offered again — `lede_fa` stays NULL for the life of the row.

The result is a panel row with a Persian headline beside a permanently English
lede, and the watchdog's backlog probe cannot see it: that probe also filters
on `headline_fa IS NULL`.

## Why it matters

It is a permanent, silent gap in exactly the population where it is most
likely: a news burst (more than 60 unread items) or a digest failure, which is
to say a busy tape or a Claude outage. Both are when the desk is actually
reading the panel.

It is also invisible to every health check the job has. The `EN` marker on the
lede is the only signal, and it looks identical to "this row is still in the
queue" — which it never is.

Volume is unmeasured (the local database is a seed), so how often this happens
on the host is not known. That measurement is part of the fix.

## Evidence

Checked 2026-09-13 on `feat/panel-i18n-translate` at `5e0d03c`, by running the
sequence rather than reading it:

```
lede at ingest: None
translate_rows: {'translated': 1, 'failed': 0, 'batches': 1}
after the late lede: {'headline_fa': 'FA1', 'lede': 'A late lede.', 'lede_fa': None}
pending_rows now: []
backlog probe sees (headline_fa IS NULL): 0
force would pick it up: ['2282e9ef889fbb83']
```

- `jamasp/digest.py:29-61` — `run_digest` selects `WHERE lede IS NULL AND
  read_at IS NULL ... LIMIT batch_max_items`, and returns 0 after logging to
  `source_errors` on any failure. Nothing retries a specific row; the next
  tick simply re-selects whatever is still NULL and unread.
- `config/settings.yaml` — `digest.batch_max_items: 60`; the ingest timer is
  15 minutes and `ops/systemd/jamasp-translate.timer` is `OnUnitActiveSec=10min`.
- `jamasp/translate.py` `pending_rows` — filter is `headline_fa IS NULL`.
- `jamasp/watchdog.py` backlog probe — same filter, so the gap is unobservable
  from there.
- **Negative:** this is not a `--force` bug. As of `fed7ba1`, `--force` does
  re-select the row (its `fa_source` is `'model'`), so an operator who knows
  can repair it manually. There is no automatic path.

## Fix

Two candidate shapes, both cheap:

1. **Widen the selector.** Offer a row whose `lede IS NOT NULL AND lede_fa IS
   NULL AND fa_source = 'model'`, translating only the lede field. Costs one
   call per affected row; must not touch `fa_source = 'flash'` rows, whose
   `lede_fa` is the channel's own summary.
2. **Wait for the lede.** Skip a row younger than some age whose `lede` is
   still NULL, so the digest gets its turn first. Cheaper, but it delays every
   headline for the sake of the minority that need it, and it cannot help a
   row whose lede lands after that grace period.

Whichever is chosen, the watchdog probe should cover the same population it
does — otherwise the next occurrence is silent again.

## Done when

A row whose lede arrives after its headline was translated ends up with a
Persian lede without an operator running anything, proven by a test that
translates a lede-less row, sets `lede`, runs the pass again, and asserts
`lede_fa` is filled — and a count of how often this actually happens on the
host, so the chosen shape is sized against reality rather than a guess.

## Related

- `docs/superpowers/specs/2026-09-13-panel-i18n-translate-design.md` — Track B.
- `docs/todo/018-translate-batching-is-defeated-by-the-cadence.md` — the other
  half of the cadence question; a longer interval would reduce this too.
