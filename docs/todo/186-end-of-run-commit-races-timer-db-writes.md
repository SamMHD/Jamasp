---
id: 186
title: End-of-run `git add state/` races the ingest/translate timers writing `state/jamasp.db` — `fatal: confused by unstable object source data`; the skills' close-out step has no retry
status: open
opened: 2026-09-17
owner: unassigned
closed:
---

## Problem

Every agent run ends with `git add -A state/ && git commit -m "jamasp: <run-type> <date>"`
(CLAUDE.md rule 4; `.claude/skills/scan/SKILL.md` step 4, and the equivalent
step in `brief`, `deepdive`, `retro`). `state/jamasp.db` is ~27 MB and is
written by the 15-minute `ingest` timer, the 10-minute `translate` timer and
the 5-minute dispatcher, all of which fire on the minute. When `git add`
hashes the DB while another process is writing it, git aborts the add with
`fatal: confused by unstable object source data for <sha>` (git's
before/after stat check on the blob source). The skill step is a single
`&&` chain, so the run's commit simply does not happen; nothing retries,
nothing alerts (exit 128 from the agent's shell is not a unit failure).

## Why it matters

- Rule 4's commit is the run's only durable record; a run that ends on
  this error leaves `state/jamasp.db` and any report/stance edits
  uncommitted until the next run happens to sweep them up under the wrong
  commit message. `git log` then misattributes state changes across runs.
- Scans fire at :00 (`07:00:09Z` this run), the same minute as ingest,
  translate and the dispatcher, so the collision is structural, not rare.
- Non-interactive runs under `jamasp run` do not have a human to retry.

## Evidence

Scan 2026-09-17 07:00Z, this sitting:

```
$ uv run jamasp inbox --mark-read && git add -A state/ && git commit -q -m "jamasp: scan 2026-09-17 07:00"
marked 24 items read
fatal: confused by unstable object source data for f12abfeaa74c6fb4de6e0a9166376ded03d70063
$ git add -A state/ && git commit -q -m "jamasp: scan 2026-09-17 07:00"
fatal: confused by unstable object source data for 8fcb1266119278676045d88c5d13758f78a64c4a
$ fuser -v state/jamasp.db
                     USER        PID ACCESS COMMAND
/home/jamasp/Jamasp/state/jamasp.db:
                     jamasp    3753489 F.... jamasp
$ ls -la state/jamasp.db*
-rw-r--r-- 1 jamasp jamasp 27791360 Sep 17 07:00 state/jamasp.db
-rw-rw-r-- 1 jamasp jamasp        0 Aug 17 21:08 state/jamasp.db.passlock
```

Two consecutive failures (different blob shas — the file content changed
between attempts), a concurrent `jamasp` process holding the DB open, then
a third attempt ~30 s later succeeded first try (commit `daa4f50`). Which
unit PID 3753489 belonged to was not checked (`ps -o cmd -p` not run);
by timing it is ingest (:00) or translate (:00). Not checked: whether the
`-wal`/`-shm` sidecars exist (none listed, so the DB is likely in rollback
journal mode, meaning the main file is rewritten in place during commits).

## Fix

Cheapest: make the close-out step in all four skills a retry loop
(e.g. up to 6 × `git add -A state/` with a 5 s pause) before `git commit`.

Proper: add a `jamasp commit "<msg>"` subcommand that acquires whatever
lock the pipeline stages take before writing the DB (`.passlock` or a new
`flock` in `state/`), runs `git add -A state/ reports/ && git commit`,
and releases — and have ingest/translate/dispatcher take the same lock
around their DB writes. Then point the skills at `uv run jamasp commit`
instead of raw git. Either way, a failed commit should surface: exit
non-zero from `jamasp run` so `OnFailure=jamasp-alert@%n` fires.

## Done when

The close-out step in `brief`, `scan`, `deepdive` and `retro` uses a
retrying or lock-holding commit, and five consecutive :00-aligned scans
commit without a manual retry (checked via `git log --format=%s` showing
one `jamasp: scan …` commit per scan run with no gaps).

## Related

- CLAUDE.md rule 4; `.claude/skills/scan/SKILL.md` step 4.
- todo-184 (silent scans and the delta) — same close-out step.

## Update 2026-09-22 (scan 05:00Z)

The journal-mode question above is answered: `pragma journal_mode` on
`state/jamasp.db` returns `delete` (rollback journal), and this session
opened with `?? state/jamasp.db-journal` in `git status` — a live rollback
journal from a timer write in progress. `git check-ignore -v
state/jamasp.db-journal` reports it is **not ignored** (`.gitignore` has no
`*.db*` pattern), so the skills' `git add -A state/` will stage a transient
sqlite journal into the run commit whenever one exists at close-out. This
scan avoided it with `git add -A -- state/ ':(exclude)state/jamasp.db-journal'`;
the journal had vanished by the time the commit ran (the `--mark-read` write
closed it). The fix here — whether the retry loop or the `jamasp commit`
subcommand — should also add `state/jamasp.db-journal` (and `-wal`/`-shm`
for safety) to `.gitignore`, otherwise a committed journal alongside a
mid-write DB blob is the worst-case artefact of the race.
