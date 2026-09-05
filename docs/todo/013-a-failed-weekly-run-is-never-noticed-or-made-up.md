---
id: 013
title: A failed weekly retro is never noticed after the fact, and never made up
status: open
opened: 2026-09-05
owner: unassigned
closed:
---

## Problem

`jamasp-retro.service` failed on 2026-08-30 and the week's learning simply did
not happen. Nothing on the host noticed the *absence* of the output, and
nothing re-attempted it. Six days later the only trace was a red line in
`systemctl --failed`, which no timer, check or report reads.

Two distinct holes, both about weekly cadence:

1. **No freshness check on weekly output.** `watchdog.check`
   (`jamasp/watchdog.py`) asserts on *yesterday's brief*, the ingest
   heartbeat, the wakeup queue and the OAuth credential expiry. It has no
   assertion with a horizon longer than a day, so a missing weekly artefact —
   the retro report, and by extension the playbook rewrite — is invisible to
   it by construction.
2. **No make-up path.** `Persistent=true` on `jamasp-retro.timer` only
   replays an elapse the host *slept through*; a run that fired and failed
   counts as elapsed. The next attempt is the following Sunday, a week later,
   and it arrives with no knowledge that the previous one was skipped.

## Why it matters

The desk lost a week of learning silently. As of 2026-09-05:

- `state/playbook.md` has not been rewritten since 2026-08-23 — 13 days, in a
  loop whose whole premise is a weekly rewrite. It is the one file only the
  retro is allowed to touch, so nothing else could have covered for it.
- `state/lessons-inbox.md` has been accumulating unconsumed for the same 13
  days (6,910 bytes at 2026-09-05T11:03). Its contract is that `/retro`
  empties it weekly.
- Predictions went unscored for a week, so the calibration scorecard that
  makes the forecast ledger worth keeping has a hole in it.

None of this produced a notification. The daily brief kept publishing, so
every *daily* signal stayed green while the weekly half of the analyst was
dark. That asymmetry is the real defect: the checks match the cadence of the
things that are easy to check, not the cadence of the things that matter.

## Evidence

Checked on the host 2026-09-05.

- `find /home/jamasp/Jamasp/reports -name '*retro*'` → four files:
  `2026-08-02`, `2026-08-09`, `2026-08-16`, `2026-08-23`. **No `2026-08-30`.**
- `agent_runs`, all retro rows ever:

  ```
  2026-08-02T16:00:01Z ok   exit=0  dur=296s
  2026-08-09T16:00:01Z ok   exit=0  dur=270s
  2026-08-16T16:00:01Z ok   exit=0  dur=255s
  2026-08-23T16:00:02Z ok   exit=0  dur=549s
  2026-08-30T16:00:02Z failed exit=1 dur=2s
  ```

- `stat state/`: `playbook.md` mtime `2026-08-23 16:07`,
  `lessons-inbox.md` mtime `2026-09-05 11:03` (6910 bytes, still unconsumed).
- `systemctl status jamasp-retro.service` on 2026-09-05:
  `Active: failed (Result: exit-code) since Sun 2026-08-30 16:00:04 UTC; 6 days ago`.
- `systemctl list-timers jamasp-retro.timer` → next elapse
  `Sun 2026-09-06 16:00:00 UTC`. The failed state does not block it; nor does
  it cause a make-up run before then.
- `jamasp/watchdog.py`, `check()`: the only report assertion is
  `reports/<y>/<m>/<yesterday>-brief.md`. There is no retro/weekly assertion.

Negatives worth not re-checking:

- **The alerting layer worked.** `jamasp-alert@jamasp-retro.service.service`
  ran at `2026-08-30T16:00:05Z` and `notify_log` records `ok=1` for both the
  runner notice and the systemd alert. This item is not about delivery.
- **The watchdog was not silent that week** — it fired on 08-30 and 08-31 for
  the missing daily briefs. It just has nothing to say about a weekly
  artefact, and said nothing about the retro at any point.
- **This is not the daily run cap** (`max_agent_runs_per_day: 20`, actual
  usage 8–11/day) and **not the 1200s retro timeout** (the run died in 2s).
  The 2026-08-30 failure itself was the OAuth refresh-token lapse — see
  `docs/todo/007`, already diagnosed and remediated. This item is about the
  fact that nobody found out the retro's *work* was missing afterwards.

## Fix

Two independent pieces; the first is small and worth doing alone.

1. **Weekly freshness in `watchdog.check`.** Add a violation when the newest
   `reports/*/*/*-retro.md` is older than ~8 days (one week plus a day of
   slack, mirroring the deliberate one-day lag on the existing brief check).
   Name the consequence — "the playbook has not been rewritten since
   `<date>`" — the way the credentials violation names its fix, because a
   violation the desk cannot act on is what `docs/todo/007` is about.
   Consider asserting on `state/playbook.md`'s mtime instead of, or as well
   as, the report: the report is the visible artefact, the playbook is the
   thing whose staleness actually costs something.

2. **A make-up path, or an explicit decision not to have one.** Options, in
   rising cost: let the watchdog violation stand as the human's cue (cheapest,
   and probably enough); have the failed retro enqueue a wakeup for the next
   day via `jamasp wakeup add`; or give the retro timer a short
   `OnFailure`-driven retry. A retro is not urgent to the hour, so a
   next-morning make-up is adequate — but "we decided a missed retro waits a
   week" is a legitimate answer and should be written down rather than left as
   the accidental status quo.

Note that a weekly check has a long feedback loop: it can only be verified
against a synthetic clock. Drive `check()` with its existing `now` parameter
in tests rather than waiting a week.

## Done when

- `watchdog.check` returns a violation, in a test that pins the boundary, when
  the newest retro report is older than the chosen horizon, and returns none
  when it is fresh.
- Running the check against the host's real `reports/` today reports the
  2026-08-30 gap (or reports clean, if a retro has since landed — in which
  case verify against a backdated `now`).
- The make-up question in Fix §2 is either implemented or recorded as a
  deliberate no, in this file's Resolution.

## Related

- `docs/todo/007` — the same 2026-08-30 incident from the alerting side: why
  the failure could not be diagnosed. This item is the other half: why its
  *consequence* was never noticed.
- `jamasp/watchdog.py` — `check()`, and `CREDENTIALS_WARN_DAYS` as the
  precedent for a violation that names its own fix.
- `.claude/skills/retro/SKILL.md` — what the missed run was supposed to
  produce (§2 report, §3 playbook rewrite, §3 lessons-inbox consumption).
- `ops/systemd/jamasp-retro.timer` — `Persistent=true`, which does not cover
  this case.
