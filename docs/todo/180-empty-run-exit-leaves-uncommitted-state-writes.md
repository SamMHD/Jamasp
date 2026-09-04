---
id: 180
title: An `empty` agent-run exit leaves uncommitted state writes in the working tree
status: open
opened: 2026-09-04
owner: unassigned
closed:
---

## What happened

Wakeup #42 (August payrolls deepdive) attempt 1 — `agent_runs` id 364,
13:15:01–13:19:11Z, exit 0, status `empty` — scored prediction `16085af9`
(rewrote `state/predictions.jsonl`), appended a lesson to
`state/lessons-inbox.md` and touched `state/jamasp.db`, then exited without
a report section, a stance rewrite or a commit. `jamasp run` correctly
recorded the run as `empty` and left the wakeup pending; the retry (attempt
2) found the writes as an unexplained dirty working tree and had to
reconstruct what the first attempt had done from `git diff`.

## Why it matters

- If the retry had also failed, the next fixed-timer run (a 2-hourly scan)
  would have committed the orphaned writes under `jamasp: scan <date>`,
  misattributing a scored prediction and a lesson.
- If the wakeup had been rescheduled to a different host/checkout, the
  writes would have been lost outright.
- The `empty` classifier fires on exit-0-with-no-commit; it cannot tell
  "did nothing" from "did half and stopped", and the desk Telegram for an
  empty run says the former.

## Proposed fix (needs a decision)

1. In `jamasp run`, on an `empty` exit, if `git status --porcelain state/
   reports/` is non-empty, commit it as
   `jamasp: <run-type> <date> (partial — run exited empty)` so the writes
   are attributed and durable, and say so in the desk notice.
2. Alternatively stash-and-flag, but a commit is simpler and matches
   hard rule 4.
3. Separately (analysis-side, lessons-inbox 4 Sep): data-event wakeups
   should default to print+60, not print+45 — CME FedWatch relays on our
   feeds lag the print by ~45–60 min (the 4 Sep odds line first appeared
   on actionforex's front page at ~13:20Z for a 12:30Z print).
