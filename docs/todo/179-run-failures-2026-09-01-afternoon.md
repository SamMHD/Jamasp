---
id: 179
title: Three consecutive agent runs failed 14:45–15:00Z on 1 Sep (ISM deepdive + scan); root-cause from journal
status: open
opened: 2026-09-01
owner: unassigned
closed:
---

## Problem

Every agent run between 13:01Z and 17:00Z on 2026-09-01 failed with exit 1,
and two of the three failures died in ~4 seconds — fast enough that they look
like launch-level errors (auth/API/wrapper), not analysis errors. The 17:00Z
scan ran normally, so whatever it was recovered on its own. Cause unknown.

## Why it matters

The failed 14:45Z run was wakeup #44 — the ISM deepdive gating prediction
`951d8286` and the first data read after Warsh. It burned both attempts
(`status: failed`, attempts=2) and its analysis only happened because the
17:00Z scan absorbed the scoring two hours late, on an alert-worthy news day
(US strikes on Chabahar/Bandar Abbas, gold −2%). A same-day recurrence during
the 4 Sep NFP window would leave a first-tier data gate unread.

## Evidence

All from `state/jamasp.db` (`agent_runs`, `wakeups`, `notify_log`), read
17:00Z, 1 Sep:

- run 332, deepdive (wakeup #44), 14:45:01→14:47:26Z (2m25s), exit 1, failed
- run 333, deepdive retry, 14:50:01→14:50:05Z (4s), exit 1, failed
- run 334, scan, 15:00:02→15:00:06Z (4s), exit 1, failed ("failed after
  retry" per the 15:00:36Z desk notice — retry not visible as its own row)
- wakeup #44: `status=failed`, `attempts=2`, `fired_at=2026-09-01T14:50:05Z`
- Alerting DID work: notify_log 159 (14:50:06Z, wakeup #44 failure), 160
  (15:00:36Z, scan failure), 161 (15:00:37Z, `jamasp-alert@jamasp-scan`
  Persian unit alert), all `ok=1`.
- Runs 327–331 (07:00–13:00Z) and the 17:00Z scan all `ok` — the failure
  window is exactly 14:45–15:00Z.
- NOT yet checked (needs the host journal, out of scope for a scan run):
  `journalctl -u jamasp-*` for 14:45–15:01Z — the actual stderr of runs
  332–334; whether the 2m25s first failure and the two 4s failures share a
  cause; whether the alert message bodies captured a usable log excerpt.
- Daily run cap ruled unlikely as the cause: the 17:00Z scan ran fine.

## Fix

Read the journal for the three failed runs, name the failure mode, and decide
whether anything needs hardening (e.g. backoff-and-requeue in `jamasp run`
for launch-level errors instead of burning wakeup attempts within 5 minutes,
or a third attempt for wakeups whose failures took <30s). The ISM analysis
itself needs no recovery — scored as `951d8286` miss by the 17:00Z scan.

## Done when

The journal excerpt for runs 332–334 is in this file with a named root
cause, and either a hardening change shipped or a written decision that the
transient needs none. Abandonment is legitimate if the journal has rotated
out before anyone looks.

## Related

- `docs/todo/` predecessor incidents: 28–31 Aug dark window (wakeup #43
  re-base task text in `state/jamasp.db`)
- `.claude/skills/alerting/SKILL.md` — alert path, which worked here
