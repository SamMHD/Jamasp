---
id: 205
title: jamasp-scan was OOM-killed on four of eight slots on 3 Nov (09/13/15/17Z, 1.7G peak) — the unit has no memory cap, the host is swapping, and a dead scan slot is never made up
status: open
opened: 2026-11-04
owner: unassigned
closed:
---

## What happened

`notify_log` ids 390–393 (2026-11-03 09:02Z, 13:01Z, 15:03Z, 17:01Z): four
`jamasp-alert@jamasp-scan.service` notices, each `result: oom-kill (status
143)`, `state: failed/failed`. The journal tails show the pattern across the
day:

| slot | result | peak memory |
|---|---|---|
| 05:00Z | ok | 328.7M |
| 07:00Z | ok | 1.6G |
| 09:00Z | **oom-kill** | 1.7G |
| 11:00Z | ok | 1.5G (+45M swap) |
| 13:00Z | **oom-kill** | 1.7G (+57.9M swap) |
| 15:00Z | **oom-kill** | 1.7G |
| 17:00Z | **oom-kill** | — |
| 19:00Z | ok (commit `aef3756`) | — |

At 03:35Z 4 Nov the host had 3,809M RAM with 2,787M used, 157M free, and
1,662M of 2,047M swap in use; `systemctl show jamasp-scan.service` reports
`MemoryMax=infinity`, `MemoryHigh=infinity`, `MemoryPeak=862M` (the last
run). The scan's own peak (~1.5–1.7G) is roughly half the box; whatever
holds the other ~2.7G between runs (panel / authd / bot / ingest — not
measured this run) decides whether the kernel picks the scan.

## Why it matters for analysis

- The 17:00Z scan is the named reader of the JOLTS relay for a dated
  December sentence (rule 14); it died, so the Wed brief ran the rates leg
  on Monday's 76.6% through a 5bp 2y round-trip.
- The 13:00Z/15:00Z scans were the named readers for a CENTCOM / White
  House statement on Qeshm (the `b4938377` falsifier); Trump's on-record
  confirmation (Tue ~23:00Z) was read only by the Wed brief.
- Rule 13 says a failed *weekly* slot is made up by a same-day wakeup; a
  failed scan slot has no make-up path — the next scan reads a 4-hour
  delta with no notion that the previous one died, and nothing re-arms
  the markers the dead slot owned.
- Four desk alerts in one day with identical text; the desk cannot tell a
  trend from the notices (same gap as todo-201 for `jamasp-bot`).

## Suggested fix

1. Measure first: a day of `MemoryPeak` / `MemoryCurrent` per unit
   (`jamasp-panel`, `jamasp-authd`, `jamasp-bot`, `jamasp-ingest`,
   `jamasp-scan`) and `free -m` at each scan start, logged to the journal.
2. Cap the always-on units with `MemoryHigh=`/`MemoryMax=` (todo-201 item
   1) so an agent run is never the kernel's cheapest victim; consider
   `MemoryMin=`/`MemoryLow=` on the agent-run slice.
3. Size swap and `vm.swappiness` for a 3.8G box running a Node panel plus
   Claude runs, or move the panel off the analysis host.
4. Have `jamasp run` treat `oom-kill` as a retryable failure with a
   backoff (its one retry evidently did not save any of the four slots —
   check whether the retry ran at all under status 143).
5. Have `jamasp-alert@` include `MemoryPeak` and `free -m` (todo-201 item
   2) so the desk sees the slope.

Related: todo-201 (bot OOM, no cap, no RSS in alert), todo-189 (no run
between 19Z and 03:30Z), todo-184 (silent scans consume the delta).

Filed by the 4 Nov 2026 brief (analysis run; not fixed mid-run). Append
recurrences here rather than re-filing.

## Update 2026-11-08 (retro)

Full-week tally: **nine `oom-kill (status 143)` alerts** — scan 3 Nov 09:02Z, 13:01Z, 15:03Z, 17:01Z; **brief 4 Nov 03:42:47Z** (killed at 03:42:44Z, 18 s after its Telegram summary at 03:42:29Z and 9 s after its commit `b163a57`); scan 4 Nov 07:04Z, 11:01Z, 13:01Z, 19:03Z (notify_log 390–393, 395, 397–399, 401). Every killed run had already committed (56 scan + 7 brief commits this week = every slot), so the kills land in the wrapper's tail. Consequences verified this run: (1) **`agent_runs` shows 55 ok / 0 failed for the week** — `_record` is called only after the retry in `jamasp/runner.py:162`, so a SIGKILL of the cgroup leaves no row, the daily cap undercounts, and the ledger is blind to all nine; (2) the one retry never ran (no second `scan: ok` line in any alert tail); (3) `--mark-read` may not have run on the killed slots (not verified — no journal access). Host at 16:00Z Sun 8 Nov: 3809M total, 2330M used, 602M free, **swap 1819/2047M**; `jamasp-scan` and `jamasp-brief` `MemoryMax=infinity` (brief peak 1.5G), `jamasp-bot` `MemoryMax=1G` with `MemoryPeak` at the cap, `jamasp-authd` 256M. Other tenants by RSS: `warp-svc` 310M, `python server.py` 303M, `n8n` 301M, `receipt-claude` node 77M, dockerd. The run user is not in `adm`/`systemd-journal`, so the kernel OOM lines (which process, what was free) are unreadable from a retro — add that to item 1 (log `free -m` from inside the run) and consider granting the run user journal read. Suggested fix 4 sharpened: write the `agent_runs` row at START (status `running`) and update at the end, so a killed run is visible as a stale `running` row and the cap counts it.
