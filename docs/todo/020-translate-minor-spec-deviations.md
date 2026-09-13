---
id: 020
title: Three minor deviations between the translate spec and the shipped job (--limit, the model flag, the translator field)
status: open
opened: 2026-09-13
owner: unassigned
closed:
---

## Problem

Three small, independent places where `jamasp translate` does not match the
design spec. None is a fault today; each is the kind of gap that is cheap now
and confusing later.

1. **`--limit N` is unimplemented.** The spec's CLI signature is
   `jamasp translate [--dry-run] [--force] [--only rows|events|docs] [--limit N]
   [--check]`. The shipped command has every flag but `--limit`.
2. **`translate.cmd` drops `-m gpt-5-codex`.** The spec pins the model in the
   command; the shipped config does not, so the job runs whatever model the
   installed codex defaults to — which can change under the host without any
   change here.
3. **The sidecar's `translator:` field is hard-coded `"codex"`.** It is
   written from `DEFAULT_TRANSLATOR` regardless of what `translate.cmd`
   actually points at, so a host running the spec's supported
   `protocol: stdout` with `claude -p` produces sidecars that claim codex
   translated them.

## Why it matters

Different weights, all small:

- `--limit` is an operator convenience — the one-tick "translate ten rows and
  let me look at them" that makes a first enable on a live host less of a
  commitment. Its absence is why the enable step in the deploy skill can only
  offer `--dry-run`.
- The unpinned model is a silent-drift risk of the same family the repo
  already guards against elsewhere (`runs.claude_cmd` pins `--model fable`,
  `digest.claude_cmd` pins haiku). A translator that changes model on an
  `npm update` changes the Persian on the panel with no diff anywhere.
- `translator:` is provenance. The field exists so that a complaint about
  wording can be traced to what produced it; a field that is always `codex` is
  worse than no field, because it will be believed.

## Evidence

Checked 2026-09-13 on `feat/panel-i18n-translate` at `5e0d03c`.

- `uv run jamasp translate --help` lists `--dry-run`, `--force`, `--only`,
  `--check`, `--db`, `--config-dir`. No `--limit`.
- `config/settings.yaml` `translate.cmd` is `["codex", "exec", "--ephemeral",
  "--skip-git-repo-check", "--ignore-user-config", "-s", "read-only"]`; the
  spec's block ends `"-s", "read-only", "-m", "gpt-5-codex"`.
- `jamasp/translate.py` — `DEFAULT_TRANSLATOR = "codex"`, and `translate_docs`
  calls every document function without a `translator` argument, so the
  default is always what is written. `run_translate` never reads a translator
  name out of `cfg`.
- **Negative:** `protocol: stdout` is not hypothetical — `jamasp/modelrun.py`
  implements and tests both protocols, which is what makes (3) reachable by a
  config edit alone.

## Fix

- `--limit N`: pass through to the row/event selection ceiling, overriding
  `batch_size * max_batches_per_run` for that run. Docs are bounded separately
  by `max_doc_calls_per_run`; decide whether `--limit` should touch them too
  and say so in the help.
- `-m gpt-5-codex`: add it to `translate.cmd` — but check first that the
  installed codex on the host accepts that model id, since a wrong pin fails
  every call while still exiting zero (the failure mode `--check` and the
  backlog probe exist for).
- `translator:`: derive it from `translate.cmd[0]` (or an explicit
  `translate.translator` key) and thread it through `translate_docs` to the
  document writers.

Each is independent; closing one does not require the others.

## Done when

`--limit 10` bounds a run to ten rows, proven by a test; `translate.cmd` pins
a model id that `jamasp translate --check` accepts on the host; and a sidecar
written with a `claude -p` command records `translator: claude`, proven by a
test. Partial closure is fine — record which parts landed in `## Resolution`.

## Related

- `docs/superpowers/specs/2026-09-13-panel-i18n-translate-design.md` — the CLI
  signature, the "Command and protocol" block, and the front-matter shape.
