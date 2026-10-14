---
id: 200
title: The farsi-brief lock file state/jamasp.db.farsibrief.lock is not gitignored, so the first `git add -A state/` after a /brief tracks an empty lock file forever
status: open
opened: 2026-10-12
owner: unassigned
closed:
---

## Problem

`jamasp/farsibrief.py#lock_path` (line 36-41) derives the bot's run lock as
`<db file>.farsibrief.lock`, i.e. `state/jamasp.db.farsibrief.lock`. The
docstring says it is "always empty, so the agent runs' `git add state/` never
sees it change" - but an *untracked* file is not a *changed* file: every
analysis run closes with `git add -A state/` (CLAUDE.md rule 4, the scan /
brief / deepdive / retro skills), and `-A` stages new files. The first agent
commit after the first `/brief` tracks the lock; from then on it is part of
the repo on every host that checks `live` out.

`jamasp/flash.py#lock_path` (line 42-50) avoided exactly this by naming its
lock `<db file>.passlock`, which `.gitignore` line 8 (`*.passlock`) covers.
The farsi-brief lock copied the derivation but not the suffix, and nothing in
`.gitignore` matches `*.farsibrief.lock` or `*.lock`.

## Why it matters

- A lock file checked into git is wrong on its face: a fresh clone starts
  with the file present (harmless for `flock`, but confusing to anyone
  reading `state/`), and a `git pull` that touches it races the bot's open
  handle.
- Every scan commit that sweeps it in is a scan that committed something
  other than analysis state, which is the thing rule 4 is meant to keep
  clean. The 15:00Z scan on 12 Oct had to exclude it by hand with a pathspec;
  no other run does that, so the next brief/scan will commit it.

## Evidence

Observed 2026-10-12 15:00Z scan (this file's author), same sitting:

```
$ git status --short state/
 M state/jamasp.db
?? state/jamasp.db.farsibrief.lock
$ ls -la state/ | grep -i lock
-rw-rw-r-- 1 jamasp jamasp 0 Oct 12 13:16 jamasp.db.farsibrief.lock
-rw-rw-r-- 1 jamasp jamasp 0 Aug 17 21:08 jamasp.db.passlock
$ git ls-files state/ | grep -i lock
(nothing - not yet tracked)
$ grep -n "lock" .gitignore
8:*.passlock
```

The lock was created at 13:16Z on 12 Oct, i.e. by the first `/brief` the
desk sent after PR #52 (`feat/telegram-farsi-brief`) merged to `live`. The
passlock from 17 Aug is the flash lock and is ignored. The 12 Oct 15:00Z
scan staged with `git add -A state/ ':!state/jamasp.db.farsibrief.lock'` so
the file is still untracked at the time of writing.

**Recurrence 2026-10-14 05:00Z scan:** the predicted sweep happened. The brief
of 14 Oct 03:35Z noted the lock "left uncommitted" but did not exclude it, and
the 05:00Z scan's plain `git add -A state/` committed it in `9cdff04`
(`state/jamasp.db.farsibrief.lock | 0`). The file is now tracked on `live`, so
the fix must include the `git rm --cached` step below.

## Fix

Either (pick one; the first is the smaller change):

1. Add `*.farsibrief.lock` to `.gitignore` next to `*.passlock`, with a
   comment mirroring the one for `.*.tmp`.
2. Rename the suffix in `farsibrief.lock_path` to `.farsibrief.passlock` so
   the existing `*.passlock` rule covers it (update the docstring and any
   test that asserts the path; `jamasp/bot.py:89` calls `lock_is_held`, not
   the path, so it is unaffected).

If the file has been committed by the time this is worked, also
`git rm --cached state/jamasp.db.farsibrief.lock` in the same change.

## Done when

`git status --short state/` on the live host shows no `??` line for the lock
while `jamasp-bot` is running, and `git ls-files state/ | grep -i lock`
prints nothing - checked after at least one `/brief` and one subsequent
agent-run commit.

## Related

- PR #52 (`feat/telegram-farsi-brief`), `jamasp/farsibrief.py`,
  `jamasp/flash.py#lock_path`, `.gitignore` lines 8 and 13-17.
- The `.*.tmp` ignore rule was added for the same failure mode (translate
  sidecar temp files swept in by rule 4).
