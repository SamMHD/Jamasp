---
id: 199
title: The 900s brief timeout cuts the run between the state rewrite and delivery on 4 of the last 10 days - the blind retry re-runs the whole brief and only a memory note stops it duplicating predictions and the Telegram summary
status: open
opened: 2026-10-12
owner: unassigned
closed:
---

## Problem

`config/settings.yaml` sets `runs.timeouts_seconds.brief: 900`. A normal
brief at `--effort xhigh` takes 12-15 minutes end to end (context load,
micro-retro scoring, 2-3 extracts, report, stance, predictions, wakeups,
Telegram, mark-read, commit), so the first attempt is killed at 15:00 on
roughly every other day - always late, after the report and most state files
are on disk but before the Persian summary is sent, the inbox is marked read
and the commit lands.

`jamasp/runner.py#run` (lines 156-160) then retries immediately with the
identical command. The retry has no idea it is a retry: nothing in the prompt,
environment or working tree tells it the report already exists. The only
thing that currently stops it re-scoring yesterday's predictions, re-adding
today's claims, appending the lessons bullets a second time and sending a
second Telegram brief is the agent's own memory note
(`brief-retry-resume.md`, written after the 8 Oct recurrence), which depends
on the model reading `git status` first and recognising the pattern.

## Why it matters

- Each cut-off burns a second agent run from `max_agent_runs_per_day: 20`
  and 3-7 extra minutes; four cut-offs in ten days is ~4 runs/week of budget
  spent on re-reading state that was already written.
- The resume path is a memory note, not code. A brief that starts from the
  skill text alone (new host, memory dir lost, a model that skips the
  `git status` check) would duplicate predictions in `state/predictions.jsonl`
  (poisoning the retro scorecard), double the lessons bullets, and send the
  desk two briefs with different numbers. The 10 Oct recurrence already
  showed the step order varies between attempts (that one was cut BEFORE the
  stance rewrite), so a naive "report exists => skip to delivery" check is
  not sufficient either.
- The kill lands inside the window where state is half-written: on 12 Oct
  the stance and lessons were modified at 03:44:14Z and the process was
  killed at ~03:44:37Z. A kill 20 seconds earlier would have left a
  truncated `state/stance.md` for the retry to read as yesterday's view.
- The alert channel never sees it: the retry succeeds, so `agent_runs` gets
  one `ok` row and no notice. The pattern is invisible unless someone
  compares `finished_at - started_at` against the timeout.

## Evidence

`agent_runs` brief rows (started -> finished; cap 900s; a total over ~15:00
means the first attempt timed out and the retry finished the run):

| date | run id | started | finished | total | cut? |
|---|---|---|---|---|---|
| 2 Oct | 632 | 03:30:01Z | 03:42:24Z | 12:23 | no |
| 3 Oct | 643 | 03:30:00Z | 03:42:53Z | 12:53 | no |
| 4 Oct | 652 | 03:30:00Z | 03:51:34Z | 21:34 | **yes** |
| 5 Oct | 662 | 03:30:01Z | 03:41:54Z | 11:53 | no |
| 7 Oct | 680 | 03:30:01Z | 03:44:02Z | 14:01 | no |
| 8 Oct | 689 | 03:30:01Z | 03:47:38Z | 17:37 | **yes** (memory note written) |
| 9 Oct | 698 | 03:30:02Z | 03:44:25Z | 14:23 | no |
| 10 Oct | 707 | 03:30:02Z | 03:52:02Z | 22:00 | **yes** (cut before the stance rewrite) |
| 11 Oct | 716 | 03:30:01Z | 03:45:00Z | 14:59 | no - finished with ~1s to spare |
| 12 Oct | 727 | 03:29:37Z | ~03:48Z | ~18:30 | **yes** (this run; cut after stance+lessons, before notify) |

12 Oct detail, checked in the same sitting: `ps -eo pid,etimes,cmd` at
03:45:17Z showed `jamasp run brief` at etimes 940 and the retry `claude -p`
at etimes 40; `reports/2026/10/2026-10-12-brief.md` mtime 03:42:xx,
`state/stance.md` and `state/lessons-inbox.md` mtime 03:44:14Z,
`state/predictions.jsonl` 03:38:42Z (five scorings + three new claims
present); `notify_log` max id 312 (Sunday's retro), 73 unread items, nothing
committed. The retry did only notify -> mark-read -> commit (notify_log 313,
commit 0a00129). The first attempt's stance header also carried the wrong
run number (#717 for max(agent_runs.id)+1 = 727) - a side effect of the
header being written under time pressure.

The 6 Oct row (671, `failed`, 9:41) is the usage-limit failure of todo-198,
not a timeout. Scans (300s cap) and deepdives (900s) show no comparable
pattern in the same window; the retro cap is already 1200s.

Not checked: whether `jamasp run` writes the attempt's stdout tail anywhere
the retry could read (todo-007 says it does not).

## Fix

1. Raise `runs.timeouts_seconds.brief` to 1200 (the retro's value): the
   observed p90 is ~15:00 and the slowest clean run 14:59, so 1200 gives the
   first attempt the headroom to finish and leaves the retry for real
   failures. Cheap, one line, do this first.
2. Make the retry self-aware: in `runner.py#run`, when the first attempt
   ends `timeout` (not `failed`), set an environment variable or append a
   line to the prompt for the retry (`JAMASP_RETRY_AFTER_TIMEOUT=1`, or
   `/brief --resume`) and teach the `brief`/`scan`/`deepdive` skills a
   "resume" preamble that codifies what `brief-retry-resume.md` says:
   check `git status`, the report mtime, the stance header date, the
   `predictions.jsonl` tail, `notify_log` max row and the unread count, then
   do only the missing steps. The memory note then becomes documentation,
   not the safety net.
3. Record the attempt count on the run row (`agent_runs.attempts`, or a
   status `ok-after-timeout`) so the watchdog / retro can count cut-offs
   instead of inferring them from durations.
4. Optional: have the brief skill move the Telegram send before the stance
   rewrite (report -> predictions -> notify -> stance -> mark-read ->
   commit) so a kill in the state phase never costs the desk its summary.
   Only worth doing if (1) does not remove the cut-offs.

## Done when

- Two consecutive weeks of brief rows with `finished_at - started_at` under
  the configured cap and no retry (check via (3), or by the durations
  table above until (3) lands).
- A forced timeout (set the cap to 60s for one run on a dev host) produces a
  retry that sends exactly one Telegram message, adds no duplicate
  prediction ids and appends no duplicate lessons bullet - verified by
  `notify_log`, `predictions.jsonl` and `lessons-inbox.md` diffs.
- Or abandoned with a reason: if the brief is instead split into smaller
  runs or the effort level is lowered so that 900s is comfortably enough,
  record that here.

## Related

- `jamasp/runner.py` lines 88-126 (`_execute_once`, SIGKILL on timeout) and
  156-160 (blind immediate retry).
- `config/settings.yaml` `runs.timeouts_seconds`.
- Memory note `brief-retry-resume.md` (8 Oct, updated 10 Oct) - the
  current, model-side safety net this item should make redundant.
- todo-007 (run failure alerts cannot say why - output capture), todo-198
  (usage-limit failures - the other reason a retry is wasted), todo-013
  (a failed weekly run is never noticed).
- Brief commits that were retries: 0a00129 (12 Oct), 10 Oct and 8 Oct
  brief commits (`git log --format='%ci %s' -- reports/2026/10/`).
