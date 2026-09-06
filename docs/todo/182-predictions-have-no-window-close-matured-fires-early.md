---
id: 182
title: Predictions carry no claim-text window close; `matured` fires at creation clock-time + N days and downstream text inherits the miscount
status: open
opened: 2026-09-06
owner: unassigned
closed:
---

## Problem

`jamasp predictions add` takes `--horizon-days N` (integer) and nothing
else about *when* the claim resolves. `predictions.due()` and
`open_unscored()` (`jamasp/predictions.py:63-73`, `93-102`) compute
maturity as `created_at + timedelta(days=N) <= now`. Almost every claim's
text says "through <date> 23:59Z", but claims are created at brief time
(~03:30Z) or scan time, so the `matured: true` flag fires 10–21 hours
before the window the claim will actually be scored on has closed.

Nothing in the CLI knows the claim's real window, so `predictions due`
cannot tell a run "this one is still open until 23:59Z" — it says
"matured, unscored", and a run that trusts the flag scores early or, worse,
copies the miscount into a wakeup task or stance line.

## Why it matters

- **Premature scoring risk.** A no-event claim ("no X through 23:59Z") is
  determinate only at window close. Scoring it at 03:32Z on the last day is
  the class of error playbook rule 2/18 exists to prevent; every brief and
  retro now has to hand-defer these, and each deferral is a judgment call
  that a tired run may not make.
- **The miscount propagates.** On 31 Aug the deepdive's task text said
  "score ALL 8 matured" — 4 of the 8 still had open windows. The flag is
  the only machine-readable maturity signal, so any automation built on it
  (the panel, a future auto-scorer, wakeup task generation) inherits the
  same off-by-a-day.
- **Calibration integrity.** A claim scored early can only be scored hit
  (the falsifier hasn't had its full window) — a systematic bias toward
  hits on exactly the structural-negative family that is already 22/22.

## Evidence

All observed on this host, 28 Aug–6 Sep 2026:

- `8babc60f` (created 2026-08-21T01:08Z, horizon 7d, claim text "21–28 Aug
  23:59Z"): `predictions due` listed it matured from 28 Aug 01:08Z — ~21h
  before window close. The 28 Aug brief deferred by hand (lessons-inbox
  entry 2026-08-28).
- 31 Aug: `predictions due` returned 8 matured; `d9e50362` `f73172f8`
  `6f8b0433` `2d9fac65` all had claim-text windows "through 31 Aug 23:59Z"
  still open at run time. Wakeup #40's task text, written from the flag,
  said "score ALL 8" (lessons-inbox 2026-08-31). Scored correctly at the
  1 Sep 03:35Z brief instead.
- `b6794dbb` (23 Aug retro) and `fe35b77d` (6 Sep retro, created
  2026-08-23T03:32Z, horizon 14d, window "through 6 Sep 23:59Z"): both
  flagged matured ~20h early, both hand-deferred to the next brief.
- `uv run jamasp predictions add --help` (run 6 Sep 16:00Z): options are
  `--direction`, `--horizon-days`, `--confidence`, `--path`, `--db`,
  `--config-dir`. No `--until`/`--window-close`.
- `jamasp/predictions.py:69`: `if created + timedelta(days=e["horizon_days"]) <= now_dt:` — the only maturity test.
- Negative: no existing todo covers this (`grep -liE 'horizon_days|matured|window close' docs/todo/*.md` → none before this file).

## Fix

Smallest change that removes the class of error:

1. Add an optional `--until <ISO-8601>` to `predictions add`, stored as
   `window_close` on the entry. When present, `due()`/`open_unscored()`
   use `window_close <= now` instead of the horizon arithmetic;
   `horizon_days` stays for display/back-compat (derive it from
   `window_close - created_at`, rounded up, when `--until` is given).
2. `render_due` prints `window_close` (or "derived from horizon") per row
   so a run can see which maturity signal it is looking at.
3. Migration: entries without `window_close` keep today's behaviour.
   Optionally, a one-off script that parses "through <date> 23:59Z" out of
   existing claim text and backfills `window_close` — the phrasing is
   consistent enough that a regex catches most of the ledger.
4. Skill side (brief/scan/deepdive/retro): the `predictions add` example
   gains `--until "<date>T23:59:00Z"` and the note "score a no-event claim
   only at `window_close`".

Analysis-side half is already in the playbook (rule 18, 6 Sep rewrite):
until this lands, round `horizon_days` up and derive score lists from
claim text.

## Done when

- `predictions add --until 2026-09-30T23:59:00Z ...` stores `window_close`
  and `predictions due` does not list that entry as matured until that
  instant (test pins the boundary with a synthetic `now`).
- Entries without `window_close` behave exactly as before (existing tests
  pass unchanged).
- `render_due` output shows which maturity signal each row used.
- The brief and retro skills' `predictions add` examples carry `--until`.

## Related

- `state/playbook.md` rule 18 (6 Sep 2026) — the manual discipline this
  replaces.
- `docs/todo/180` — the other half of the 31 Aug/4 Sep run hygiene
  (partial-run commits).
- `reports/2026/09/2026-09-06-retro.md` — the fortnight's four
  hand-deferrals.
