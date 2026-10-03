---
id: 196
title: "`state/watchlist.yaml` (69KB) and `state/calendar.yaml` (107KB) are append-only run logs read whole by every brief; nothing prunes or archives them"
status: open
opened: 2026-10-03
owner: unassigned
closed:
---

## Problem

The brief skill's step 1 says "Read `state/stance.md`, `state/playbook.md`,
`state/watchlist.yaml`, and `state/calendar.yaml`" and calls it cheap. It is
not any more: at the 3 Oct brief a single `cat` of the four files returned
194KB (watchlist 65KB, calendar 107KB), and the run had to re-read them
piecemeal. Every brief since August has appended a dated note to each
watchlist theme's `why:` block (fed-rate-path alone is ~215 lines) and a
new entry to `calendar.yaml` (63 entries, most of them resolved events from
August and September with their `outcome:` text).

CLAUDE.md rule 5 ("Keep state small … rewrite, don't append") is written for
`stance.md` only; the watchlist and calendar have no size rule and no
consumer that prunes them. The Monday watchlist prune removes whole themes
stale for 4+ weeks, not the per-run notes inside live themes.

## Why it matters

- Context cost: ~50K tokens of mostly-historical state loaded (or
  skimmed around) at the start of every brief, scan and deepdive that
  follows the skill literally — the same tokens the run needs for the
  inbox and extracts.
- Correctness: the useful content (the latest note per theme; the next
  week's calendar entries) is buried under months of run logs, so runs
  grep for it and can miss a live entry — the 3 Oct brief found the
  upcoming calendar entries only by `sed -n 1537,1800p`.
- The archive function these notes serve already exists: `reports/` holds
  every brief, and `state/jamasp.db` holds the predictions.

## Suggested fix

Either (a) a convention plus a small CLI (`jamasp state prune`) that moves
calendar entries whose `date` is >14 days old and watchlist notes older than
~3 weeks into `state/archive/<file>-<yyyy-mm>.yaml`, run from the retro or
the daily watchdog; or (b) restructure both files so each theme / event
carries a single `latest:` block that runs rewrite (rule 5 style) and a
bounded `history:` list. Then amend the brief skill's step 1 to read the
pruned files, and add a size check to the watchdog.

## Evidence

- 2026-10-03 03:30Z brief: `wc -c` → stance 9689, playbook 16782,
  watchlist 64807, calendar 107110; the first `cat` of all four was
  truncated by the harness at 193.8KB.
- `calendar.yaml` entries by month: Aug 25, Sep 30, Oct 8 — 55 of 63 are
  past events with `outcome:` text.
