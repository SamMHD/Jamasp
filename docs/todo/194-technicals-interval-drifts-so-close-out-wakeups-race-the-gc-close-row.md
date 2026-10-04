---
id: 194
title: "The TradingView technicals interval runs from its last fetch, not the clock, so the GC_CLOSE row slot drifts and tape-clause close-out wakeups race it"
status: open
opened: 2026-09-30
owner: unassigned
closed:
---

## Problem

`tv_gc_technicals` (`config/sources.yaml`, `interval_minutes: 360`) is
fetched by the ingest tick only when 360 minutes have passed since its
**last** fetch. Because ingest runs every 15 minutes and the check is
"≥ interval since last", every fetch lands 0–15 minutes late and the
lateness compounds: the evening `GC_CLOSE` row printed at 23:16:07Z on
Sun 27 Sep, 23:30:26Z Mon, 23:30:44Z Tue, **23:46:21Z Wed 30 Sep**
(05:31 → 11:46 → 17:45 → 23:46Z on Wednesday alone).

Rule 14 books a tape-clause close-out "at Globex close +30" and rule 17
names "the first GC_CLOSE row at or after 23:00Z" as the basis. Wakeup #68
(booked 23:35Z by #62) ran at 23:35:01Z, polled for about three minutes,
found no row and exited `empty` — eight minutes before the row printed.
The dispatcher's single retry caught it at 23:46Z; a second slip would
have handed the clause to the 03:30Z brief and Telegrammed the desk a
failure notice for a run that had nothing to fail on.

## Why it matters

- Every rates-data and Fed-event flip carries a tape clause (rule 23),
  and each one now needs a close-out run that cannot know when its input
  arrives. The 29 Sep lessons-inbox already noted the row "lands on the
  ingest tick"; tonight it landed a full tick later than the wakeup.
- Rule 14 says a run that has written state never exits `empty`
  (todo-180). Attempt 1 wrote nothing and exited empty *correctly* by that
  rule, but the empty exit is still what the task text ("poll for up to
  15 min") was written to prevent.
- Other 6-hourly consumers inherit the same drift: the 05:15Z brief-time
  row the reopen-band claims name (lessons-inbox 28 Sep) printed at 05:31Z
  Wed.

## Evidence

```
GC_CLOSE ts (prices table):
2026-09-27T23:16:07Z  2026-09-28T05:30:18Z  11:30:33Z  17:30:14Z  23:30:26Z
2026-09-29T05:31:42Z  11:31:38Z  17:31:35Z  23:30:44Z
2026-09-30T05:31:09Z  11:46:21Z  17:45:57Z  23:46:21Z
agent_runs 620: deepdive #68 started 23:35:01Z, finished 23:38:25Z, status empty
```

## Fix

Smallest change that removes the class of error — either of:

1. **Anchor the interval to the clock.** For `interval_minutes ≥ 60`,
   fetch when `now` crosses a multiple of the interval (00/06/12/18Z, or a
   configurable `anchor_minute`), not when 360 min have elapsed since the
   last fetch. The evening row then lands on the 23:00–23:15Z tick every
   day and "first row ≥23:00Z" is a fixed slot.
2. **Or make the booker compute the slot.** `jamasp wakeup add` grows a
   `--after-next-close-row` flag that reads the last `GC_CLOSE` ts, adds
   the interval plus one ingest tick, and books there; the deepdive skill
   text tells event runs to use it for close-outs.

Option 1 is the smaller diff and fixes the basis for every consumer;
option 2 leaves the drift and papers over it. Either way, the close-out
task template should say "poll the table until the row prints (up to
20 min), then read" and the runner's per-type timeout for deepdive
(900 s) must cover the poll.

## Update 2026-10-04 (retro)

4 Oct retro: #620 (PCE close-out, booked 23:35Z Wed 30 Sep on a 23:30Z assumption) exited `empty` at 23:38Z; the row printed 23:46:21Z; #621 (23:40Z) caught it. #642 (NFP close-out) was booked at 00:35Z Sat on the cadence observed Friday (rows 00:02 / 06:15 / 12:16 / 18:17 / 00:31, ~6h14 per slot) and read the 00:31:08Z row four minutes later. Playbook rule 14 now books the close-out as an absolute time from that day's observed cadence (next ≥23:00Z slot + one ingest tick; a Friday's lands Saturday) with "poll until the row prints" — the analysis-side workaround until the interval is clock-anchored.
