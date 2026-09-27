---
id: 189
title: "No agent run exists between the 19:00Z scan and the 03:30Z brief — scans fire 05–19Z only, so every Sunday Globex open and every late-US-evening print (18:00Z+ weekend statements) goes unread for 8.5 hours"
status: open
opened: 2026-09-27
owner: unassigned
closed:
---

## Problem

The 2-hourly scan timer fires at 05, 07, 09, 11, 13, 15, 17 and 19Z and then
stops until the next day's brief at 03:30Z. `agent_runs` (queried 27 Sep
2026) has 57 scans per slot at those eight hours and none at 21Z, 23Z or
01Z on any date since the timer went live. The 26 Sep stance nevertheless
handed a task to "the 21:00Z Sunday scan" — a slot that does not exist —
and the same gap swallowed Saturday 26 Sep: Trump's on-record rejection of
Iran's seven-day Hormuz plan hit the feeds at 18:09Z (gcaptain/Bloomberg)
and 18:54Z (Gulf News), the 19:00Z scan ran for 41 seconds and stayed
silent, and the next reader was the Sunday 03:30Z brief. The Sunday Globex
open (22:00Z) — the first print after any weekend geopolitical event — is
inside the blind window every week.

## Why it matters

- The stance and scan skill route "markers" (an on-record US response, an
  SNSC "next step", a Brent ±3% settle, USDJPY at the Sunday open) to
  "the next scan". Between 19:00Z and 03:30Z there is none, and analysis
  runs have been writing as if there were (lesson filed in
  `state/lessons-inbox.md` 27 Sep).
- US data prints land 12:30–14:00Z and are covered; US *evening* events
  (White House remarks after the close, Treasury statements, weekend
  ultimatum deadlines) and the Asia open are not.
- The Dubai desk is asleep 22:00–03:00Z, so the cost of the gap is analysis
  freshness (the Monday brief works from a 5.5-hour-old open) more than a
  missed alert — which is why this is a config decision, not an emergency.

## Proposed fix (needs a decision)

One of:

1. Extend the scan timer to 21Z and 23Z (two more runs a day; check the
   daily run cap in `jamasp run` and the token budget).
2. Add a single Sunday-only 22:30Z scan for the Globex open (one run a
   week).
3. Leave the schedule and make the skills honest: the `brief`/`scan`
   skills state that the window 19:00Z–03:30Z has no reader, and the brief
   books a one-off `wakeup` when a known event lands in it.

Option 3 costs nothing and should be done regardless; 1 or 2 is the
desk's call on budget.

## Evidence

- `agent_runs` scan start-hour histogram 27 Sep 2026: 05×57, 07×57, 09×57,
  11×57, 13×57, 15×57, 17×57, 19×58, 10×1 (a manual run); nothing else.
- 26 Sep 2026 stance, "What flips me": "the 21:00Z Sunday scan re-reads
  Monday's wakeup premise."
- 26 Sep 2026 scans 571–578: 25–75 seconds each, exit 0, no notify.
