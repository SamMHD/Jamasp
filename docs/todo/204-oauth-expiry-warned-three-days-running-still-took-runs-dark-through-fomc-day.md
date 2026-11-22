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

## Recurrence — 17–19 Nov 2026 (different cause, same shape; next lapse now dated)

- **Tue 17 Nov 09:00Z → Thu 19 Nov 13:00Z: 23 consecutive agent runs failed**
  in ~3 s each (`agent_runs` 1059–1081: 19 scans, the Wed 18 and Thu 19
  briefs, the FOMC-minutes deepdive ×2) on
  `API Error: Your account can't receive replies from Claude right now. You
  can find the next step in the Anthropic Verification Portal` — an
  account-side verification block, not the OAuth expiry. 54 hours dark
  through retail sales, Nvidia, Waller's 50bp call, the FOMC minutes and
  gold's break of 3,800 (3,880 → 3,707); ~46 identical failure alerts to the
  desk. First run back: the Thu 15:00Z scan (1,076 unread; alert sent;
  catch-up deepdive #81 booked for 22:20Z).
- The credential probe cannot see this failure class (the token was valid);
  the alert text carried the portal URL but nothing marked it "human action
  on the account, not the host". The credential fallback (fix 4) would
  have helped only if the API key sits on a different account/org from the
  blocked one.
- **The same failure output carries the next dated lapse:** "this sign-in
  ends between 2026-11-22 and 2026-11-25 … Run `claude auth login` before
  then, or use `claude setup-token` for unattended jobs." The Thu 15:00Z scan
  alert relayed it to the desk in Persian. 22 Nov is a Sunday (retro day).

### 2026-11-22 (retro, 16:01Z)

- `~/.claude/.credentials.json` read in this run (expiry fields only):
  `refreshTokenExpiresAt` = **2026-11-25T10:04Z**; access-token `expiresAt`
  2026-11-23T00:00Z (file mtime 16:00Z today, so the access token is still
  refreshing). The retro itself ran, so the "22–25 Nov" lapse has not
  started.
- Without a human `claude auth login` (or `claude setup-token`) before Wed
  25 Nov 10:04Z, the first runs at risk are the 11:00Z scan and deepdive
  #84 (core PCE / GDP, 14:15Z) — the same shape as 28 Oct (FOMC day) and
  17–19 Nov (minutes, the 3,800 break).
- Week's ledger from `agent_runs`, 15 Nov 16:00Z → 22 Nov 16:00Z: scans 37
  ok / 19 failed, briefs 5 / 2, deepdives 2 / 2, retro 1 / 0. All 23
  failures sit in 17 Nov 09:00Z → 19 Nov 13:00Z and each died in 3–4 s.
- Stance and the retro's desk summary both carry the dated figure.
