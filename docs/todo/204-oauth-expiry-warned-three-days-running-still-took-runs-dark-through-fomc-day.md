---
id: 204
title: The OAuth refresh-token expiry was warned three mornings running and still took every agent run dark for 23 hours through FOMC day — the watchdog line has no escalation path and the runner has no credential fallback
status: open
opened: 2026-11-01
owner: unassigned
closed:
---

## Problem

The watchdog's credential probe (`jamasp/watchdog.py`, `CREDENTIALS_WARN_DAYS
= 3`, added after the 28 Aug lapse — see `docs/todo/007-run-failure-alerts-
cannot-say-why.md`) worked exactly as designed and the token lapsed anyway:

| When (UTC) | What | notify_log |
|---|---|---|
| Sat 25 Oct 05:00 | "refresh token expires 2026-10-27 12:02Z" (55h) | 348 |
| Sun 26 Oct 05:00 | same, "in 31h" | 351 |
| Mon 27 Oct 05:00 | same, "in 7h" | 353 |
| Mon 27 Oct 12:02 | token lapsed | — |
| Mon 27 Oct 13:00 → Tue 28 Oct 11:00 | 9 runs failed on `Failed to authenticate: OAuth session expired and could not be refreshed`: scans 13/15/17/19Z, the **Wed 28 Oct brief (FOMC day)**, scans 05/07/09/11Z (`agent_runs` 872–880) — 18 alert messages, two per failure | 354–372 |
| Tue 28 Oct 05:00 | watchdog: "EXPIRED … every agent run is failing" | 366 |
| Tue 28 Oct ~11:35 | human re-authenticated on the host | — |
| Tue 28 Oct 13:00 | first run back: the scan faced a 506-item / 26h delta (todo-199 scan variant; todo-184 mark-read) | 373 |
| Tue 28 Oct 13:14 | human-dispatched outage catch-up deepdive (#882) read all 506 | — |
| Tue 28 Oct 15:00 | scan #883 failed on the **5-hour usage limit** (todo-198, third occurrence) | 376–377 |

Outage 23 hours (27 Oct 12:02Z → 28 Oct ~11:35Z) against 3.5 days in August
— the probe shortened it, but the day lost was the FOMC-day brief, and the
recovery cost a usage-limit failure on top.

## Why it matters

The only action the warning admits is a human at a keyboard on the host
running `claude` as the service user. A 3-day lead that starts on a Saturday
gives that human one working morning (Monday, 7h before the lapse). Every
Claude-dependent path dies together — brief, scans, deepdives, the retro
make-up — and the desk receives a flood of identical alerts it cannot act on
from a phone. The next lapse falls on whatever the token's lifetime is from
28 Oct; nothing records that date anywhere a human reads daily.

## Suggested fix

1. **Lead and cadence.** Raise `CREDENTIALS_WARN_DAYS` to 7 so at least two
   weekdays precede a weekend lapse; inside the final 48h repeat the line at
   every scan slot (the scan's Persian alert, not only the 05:00Z watchdog
   line) under a distinct heading ("ACTION NEEDED — auth") so it does not
   read like the daily OK/VIOLATION roll.
2. **Say exactly what to do.** The alert already says "run `claude` as the
   service user"; add the host name, the user name and the one-line check
   (`claude -p "reply with OK"`), so it can be forwarded to whoever has SSH.
3. **Surface it in the brief.** The daily brief's "Sourcing health" line
   should carry the token's expiry whenever it is <7 days out — the brief
   reaches more eyes than the watchdog line.
4. **Credential fallback** (the real fix, shared with todo-198 §1): let
   `jamasp run` fall back to an API-key path when the OAuth path fails, so a
   lapse degrades to a cost line rather than an outage.
5. **Collapse the flood** (todo-198 §3): one "runs paused: auth" alert,
   cleared on the next success, instead of two messages per failed slot.

## Evidence

- `notify_log` 348, 351, 353 (warnings), 354–372 (failures), 366 (EXPIRED),
  373 (first scan back), 376–377 (usage-limit failure).
- `agent_runs` 872–880 (auth failures, exit 1 in ~2 s each), 882 (catch-up
  deepdive, human-dispatched — no `wakeups` row), 883 (usage limit).
- `reports/2026/10/2026-10-28-brief.md` header (written by #882 in place of
  the brief).
- `jamasp/watchdog.py` lines 17–24 (the 3-day constant and its rationale).
