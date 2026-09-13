---
id: 018
title: Translate batching is defeated by the 10-minute cadence — roughly one model call per tick regardless of batch_size
status: open
opened: 2026-09-13
owner: unassigned
closed:
---

## Problem

`translate.batch_size: 20` exists to amortise a model call over twenty rows.
`translate_rows` makes a full call for **whatever is pending**, however small,
and the timer fires every ten minutes — 144 ticks a day. So in steady state
the job pays close to one call per tick no matter what `batch_size` says: a
tick with one new item costs the same call as a tick with twenty.

There is no minimum-batch floor, and no notion of "not enough work, wait for
the next window".

## Why it matters

Pure cost, on the system's highest-volume model consumer. The spec put
translation on codex specifically so its volume would not compete with the
Claude budget; that argument is weakened if most of the calls carry one or two
rows.

The same pattern was already solved once in this codebase for the same reason:
`flash.rollup_min_items` holds a near-empty rollup rather than sending it, on
the grounds that it "costs more attention than it returns". Here it is money
rather than attention, but the shape is identical.

It also interacts with `docs/todo/017`: a longer interval, or a floor, gives
the digest time to land a lede before the headline is translated.

## Evidence

Checked 2026-09-13 on `feat/panel-i18n-translate` at `5e0d03c`, by running it:

```
model calls for ONE pending row, batch_size 20: 1
```

- `jamasp/translate.py` `translate_rows` — chunks `rows` by `batch_size` and
  calls `_batch_with_fallback` per chunk. With one pending row that is one
  chunk, one call. No floor is consulted anywhere.
- `ops/systemd/jamasp-translate.timer` — `OnUnitActiveSec=10min`, so 144
  ticks/day; `config/settings.yaml` — `batch_size: 20`,
  `max_batches_per_run: 6`.
- `jamasp/flash.py` `_rollup_pass` — the existing floor pattern
  (`rollup_min_items`, default 3): under the floor, items stay held and roll
  into the next window.
- **Unknown, and it decides the sizing:** the host's real item rate and how
  many items already carry flash Persian. The local database is a seed, so
  this cannot be measured from a checkout. The spec's Risks section asks for
  the same measurement before the timer is enabled at all.

## Fix

Pick one, sized against the measured host rate:

- **A floor.** `translate.min_batch_items`, mirroring `flash.rollup_min_items`:
  below it, translate nothing and let the rows roll into the next tick. Needs
  an escape so a quiet night does not leave one item untranslated for hours —
  an age override ("floor unless the oldest pending row is older than N
  minutes"), which also keeps the watchdog's 45-minute backlog probe honest.
- **A longer interval.** Move the timer to 20 or 30 minutes. Simpler, no code,
  but it raises the latency of every row rather than only the cheap ticks, and
  the backlog probe's threshold would have to move with it.

Either way the watchdog threshold (`TRANSLATE_BACKLOG_MINUTES = 45`) must stay
consistent with the cadence, or the alert fires on the design rather than on a
fault.

## Done when

A tick with fewer than the floor's worth of pending rows makes no model call,
proven by a test, and the measured before/after call rate on the host shows
the saving — or the item is closed as abandoned with the measured rate showing
the saving is not worth the added latency.

## Related

- `docs/superpowers/specs/2026-09-13-panel-i18n-translate-design.md` —
  decisions 7 and 15, and the "Volume is unmeasured" risk.
- `docs/todo/017-late-arriving-ledes-are-never-translated.md`.
