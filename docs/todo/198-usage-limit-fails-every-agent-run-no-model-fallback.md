---
id: 198
title: A Claude usage-limit response fails every agent run until the window resets - the brief and all nine scans of Tue 6 Oct were lost, with no model fallback and nine identical alerts
status: open
opened: 2026-10-07
owner: unassigned
closed:
---

## Problem

`jamasp run` (`jamasp/runner.py#_execute_once`) runs `claude -p` with the
model fixed in `claude_cmd` and treats every non-zero exit the same way: one
immediate retry, then a failure alert. On Tue 6 Oct 2026 every run from the
03:30Z brief (#671) through the 19:00Z scan (#679) exited 1 within seconds
with the same last line:

```
You've reached your Fable limit. Switch to another model, or manage usage
credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.
```

The brief retried once (12 minutes total) and the eight scans each failed in
under seven seconds. The desk got nine failure notices and no analysis for
24 hours: ISM services prices paid (Mon 14:00Z), the Tuesday 2y close, the 3y
auction, the Houthi airport hits, the On Peace casualties and the Monday
closer `6927fc6a` were all read for the first time at the Wed 7 Oct brief.

## Why it matters

- The run cap, retry and timeout machinery in `jamasp run` assumes failures
  are transient. A usage-limit failure is deterministic for the rest of the
  window, so the retry is wasted and every later slot fails the same way.
- The CLI's own message names the remedy ("switch to another model"), and the
  translate pass already runs through a different model for exactly this
  reason (CLAUDE.md), but the agent runner has no fallback model.
- Nine identical alerts in one day are the todo-197 shape again: a signal
  that trains the desk to ignore the failure channel.
- A lost brief silently breaks the rule-14/17 cadence (print-day 2y closes
  read "the next morning", close-out wakeups, window-close scoring under
  rule 18). This brief had to sweep two days; a Thursday repeat would have
  left `440d34a8` unscored at its window close.

## Suggested fix (needs todo-007's output capture first)

1. Capture `claude`'s stderr/stdout tail (todo-007) and match the limit
   message (`reached your .* limit`, `usage limit`).
2. On a match: skip the immediate retry, re-run once with a configured
   fallback `--model` (e.g. `claude_fallback_cmd` in config, pointing at
   Opus/Sonnet), and tag the run row (`agent_runs.status = "ok-fallback"`) so
   the retro can see which runs were produced by the fallback.
3. If the fallback also fails on a limit, write a `meta` key
   (`usage_limit_until`) and have the dispatcher/timers short-circuit with
   ONE alert ("agent runs paused until <time>: usage limit") instead of one
   per slot; clear it on the first successful run.
4. The watchdog (05:00Z) should report "N runs lost to usage limit
   yesterday" so the next brief knows it is sweeping a gap (this brief found
   out from `agent_runs` by accident).

## Evidence

- `agent_runs` rows 671-679, all `failed`, exit 1, 6 Oct 03:30Z-19:00Z.
- `journalctl -u jamasp-brief -u 'jamasp-scan*' --since 2026-10-06 03:00`:
  "You've reached your Fable limit" on every run.
- Wed 7 Oct brief (#680) ran normally at 03:30Z: the window had reset.
