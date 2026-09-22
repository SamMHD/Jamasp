---
id: 028
title: An empty translate.timeout_seconds gives the translator subprocess no timeout at all
status: open
opened: 2026-09-22
owner: unassigned
closed:
---

## Problem

`run_translate` passes `cfg["timeout_seconds"]` straight to
`modelrun.run_json`, which passes it to `subprocess`. YAML reads
`timeout_seconds:` written with no value as `None`, and a `subprocess` timeout
of `None` means *wait forever*.

`translate.check()` does not catch it: the key is present, so the
missing-keys test passes, and nothing type-checks the value.

## Why it matters

Same class of typo as the one fixed on `fix/translate-large-documents` for
`doc_chunk_bytes` and `max_doc_calls_per_run` — and the same spelling
invitation, since `translate_from:` in the same block uses an empty value to
mean "unset". The consequence here is different: not a crash the next tick
recovers from, but a call that never returns.

On the host systemd bounds it — `TimeoutStartSec=2400` kills the unit — so
the damage is a wedged tick and a desk alert rather than a permanent hang. A
manual `uv run jamasp translate` has no such bound and hangs the operator's
terminal.

## Evidence

Checked 2026-09-22 on `fix/translate-large-documents`.

- `jamasp/translate.py`, `run_translate`'s default `run`: passes
  `cfg["timeout_seconds"]` unvalidated.
- `jamasp/translate.py`, `REQUIRED_CFG_KEYS` / `check()`: presence only, no
  value check.
- `jamasp/translate.py`, `_int_setting`: the coercion that now covers
  `doc_chunk_bytes` and `max_doc_calls_per_run`. `timeout_seconds` was left
  out deliberately — it was not a key that commit touched, and widening the
  change would have put an invented default (180) in the module.
- `translate.probe` already clamps its own call with
  `min(_int_setting(cfg, "timeout_seconds", PROBE_TIMEOUT_SECONDS),
  PROBE_TIMEOUT_SECONDS)`, so `--check` is not affected.

## Fix

Either route the value through `_int_setting` with a named module default
(and say in `config/settings.yaml` that the default is what an empty value
means), or have `check()` reject a `timeout_seconds` that is not a positive
int. Prefer coercion over rejection: `floor_for` and `_int_setting` both take
the line that a config typo must not take the pass down at the first tick,
and `check()` runs on every invocation including the timer's.

## Done when

`timeout_seconds:` written empty, and `timeout_seconds: ten`, both leave the
pass running with a bounded subprocess timeout, proven by a test built from
the real YAML spelling.

## Related

- `docs/todo/027` — the other half of the timing story: even with a correct
  `timeout_seconds`, a heavy tick does not fit `TimeoutStartSec`.
