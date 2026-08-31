---
id: 010
title: 3-day agent-run outage (28–31 Aug) ran unalerted and wakeup #39 vanished
status: open
opened: 2026-08-31
owner: unassigned
closed:
---

## Problem

No agent run committed between the 28 Aug 03:39Z brief (`85c9021`) and the
31 Aug ~09:25Z redeploy (`87b6383`) — no scans, no 29/30 Aug briefs, no
Sunday retro, and wakeup **#39 (Warsh keynote read, 28 Aug 14:45Z) is gone
from `wakeup list` with no report, no commit, and no stance update**. The
31 Aug 10:14Z scan found a 713-item unread backlog and a stance three days
stale through two regime-relevant shocks (Warsh hawkish turn; US-Iran
kinetic resumption incl. Hormuz mining and a drone at a US base in the UAE).

## Why it matters

The outage window contained exactly the events the wakeup/scan machinery
exists for. Every unit carries `OnFailure=jamasp-alert@%n.service` and a
daily watchdog timer exists — yet either (a) no alert fired for three days
of dead timers, or (b) alerts fired and recovery still took three days with
no degraded-mode fallback. Separately, a dispatched wakeup that fails
terminally appears to leave the queue silently — #39 has `attempts`
accounting, but its terminal state produced no artifact and no re-raise.

## Evidence

- `git log`: gap between `85c9021` (2026-08-28T03:39:51Z) and the
  31 Aug 09:23–09:25Z deploy/merge commits; last scan commit 27 Aug 19:00.
- `jamasp wakeup list` on 31 Aug 10:15Z: #42/#41/#26 pending, #39 absent.
- 31 Aug scan: 713 unread; `state/stance.md` still dated 28 Aug.
- Unknown (needs journal/Telegram history from the host): did
  `jamasp-alert@` or the watchdog fire during the window? Was the host down
  entirely (nothing to fire) — the case a host-external heartbeat would
  catch?

## Fix

Reconstruct the outage from `journalctl` + desk-chat history, then close the
two gaps this exposes: (1) liveness alerting that doesn't depend on the dead
host itself (dead-man's-switch style external heartbeat, or at minimum
watchdog coverage for "no successful run in N hours"); (2) terminal wakeup
failure must leave an artifact — re-queue with backoff, or an explicit
failure line in the desk chat and a `wakeup list --failed` state, so a
missed #39-class read is re-raised rather than lost.

## Done when

Outage timeline documented; a simulated dead host (stop all timers 24h)
produces a desk alert; a wakeup whose run fails all retries remains visible
somewhere actionable.

## Related

`alerting` skill; `deploy` skill; todo-001 (calendar horizon — same
"quietly degrades" family); 31 Aug scan alert + provisional stance.
