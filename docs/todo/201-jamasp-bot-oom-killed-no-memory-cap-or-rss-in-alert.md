---
id: 201
title: jamasp-bot was OOM-killed (status 9) on 15 Oct 22:33Z — the unit has no memory cap and the failure alert carries no RSS, so a leak cannot be sized from the desk chat
status: open
opened: 2026-10-16
owner: unassigned
closed:
---

## What happened

`notify_log` id 324 (2026-10-15T22:33:04Z): the `jamasp-alert@jamasp-bot.service`
notice — `result: oom-kill (status 9)`, `state: activating/auto-restart`. The
attached journal tail shows `WARNING jamasp.bot: poll failed (The read operation
timed out); retrying in 2s` at 16:07Z and 16:11Z, six hours before the kill, and
nothing in between — so the alert's log section does not show the growth.

The bot auto-restarted and `/brief` service was not reported lost, so this is
filed as a gap, not an outage. First occurrence; append recurrences here rather
than re-filing.

## Gap

- No `MemoryMax=` / `MemoryHigh=` on `jamasp-bot.service` (nor on `jamasp-panel`,
  `jamasp-authd`), so a leak runs until the kernel picks a victim — which on a
  small host can be the ingest or an agent run rather than the bot.
- The failure alert (`alerting` skill) prints the last journal lines but not the
  unit's peak memory (`systemctl show -p MemoryPeak` / `MemoryCurrent`), so the
  desk cannot tell a one-off from a trend.
- Unknown whether the growth is in the long-poll loop (httpx client reuse after
  the timeout warnings) or in the per-`/brief` `codex` subprocess tree.

## Suggested fix

1. Add `MemoryHigh=`/`MemoryMax=` to the three always-on units (sized from a
   week of `MemoryPeak`), with `OOMPolicy=continue` where appropriate.
2. Have `jamasp-alert@` include `MemoryPeak`/`MemoryCurrent` and `NRestarts` in
   the notice.
3. Log the bot's RSS at each poll-timeout warning so the next journal tail shows
   the slope.

Filed by the 16 Oct 2026 brief (analysis run; not fixed mid-run).

## Update 2026-10-18 (retro)

Renumbered 200 → 201 by the 18 Oct retro: the 16 Oct brief filed this item
as 200 while `200-farsibrief-lock-file…` (opened 12 Oct by the 15:00Z scan)
already held the id — the first collision since the directory opened. Any
"todo-200" citation dated 16–18 Oct that talks about the OOM means this
file. Same unit, one more data point: the 12 Oct 13:20Z `jamasp-bot` alert
(notify_log 314) was `result: success, state: active/running` — a deploy
restart firing `OnFailure`, the todo-191 shape on a second unit — so the
bot's lifetime alerts are 1 restart + 1 OOM, and only the OOM is a failure.
