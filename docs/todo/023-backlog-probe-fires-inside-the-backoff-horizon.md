---
id: 023
title: The watchdog backlog probe can fire for a row that is backing off exactly as designed
status: open
opened: 2026-09-13
owner: unassigned
closed:
---

## Problem

Two numbers were chosen independently and overlap:

- `watchdog.TRANSLATE_BACKLOG_MINUTES = 45` — a row still untranslated this
  long after publication counts as a backlog violation.
- `translate.BACKOFF_MINUTES` — after a failure a row waits 15 minutes, then
  60, before it is offered again. A row that keeps failing is abandoned at
  roughly t+80 minutes.

So a row that fails once and is correctly waiting out its 60-minute backoff
crosses the 45-minute backlog threshold while doing precisely what the
backoff was added to make it do. The watchdog reports it as a stuck backlog;
the job reports nothing wrong, because nothing is.

Neither constant's comment mentions the other.

## Why it matters

The backlog probe exists to catch the one failure the systemd `OnFailure`
alert cannot see: a run that exits zero while translating nothing, typically
because the translator's credentials lapsed. That signal is valuable and it
reaches the desk chat.

A probe that also fires during ordinary, self-healing backoff spends the
desk's attention on a non-event. Alert fatigue on this particular channel is
expensive, because the alert it teaches people to ignore is the one that
means codex auth is dead and the panel is quietly serving English.

Not yet observable in production: the translate timer ships disabled, and the
probes are gated on a `meta.last_translate_at` stamp that only a real run
writes. It becomes live the moment the timer is enabled.

## What to do

Pick one of:

- Raise `TRANSLATE_BACKLOG_MINUTES` clear of the backoff horizon — 90 or 120
  minutes puts it past the point where a row is abandoned anyway, so the probe
  fires only for rows nothing is retrying.
- Or exclude backing-off rows from the backlog count (`fa_attempts = 0 OR
  fa_failed_at` older than the applicable delay), so the probe measures rows
  that are genuinely untouched rather than rows mid-retry.

Whichever is chosen, make each constant's comment name the other, so the next
person to tune one sees the coupling.
