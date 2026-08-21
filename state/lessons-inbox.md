# Lessons inbox

Candidate lessons from daily micro-retros and feedback; consumed (emptied)
by the weekly /retro. One bullet per lesson: date, observation, suggested rule.

- **2026-08-17 — heuristics 14, 15 and 16 now have tooling behind them; they
  should stop being disciplines and become tool references.** All three were
  written as rules the agent must remember, because a retro can only write
  prose. The code landed 17 Aug:
  - #14 → `jamasp predictions due --open` lists still-running claims, each
    annotated with `window_high`/`window_low`/timestamps over its own window.
    No hand-written SQL, and open claims are visible before maturity.
  - #15 → `jamasp run` compares git HEAD before and after; exit 0 with HEAD
    untouched is recorded as status `empty` and Telegrams the desk. Not
    retried (an empty run may already have posted). Dispatched wakeups stay
    `pending` on `empty`, so the next tick retries them.
  - #16 → `jamasp extract` prints `fetched_at` and age above the text and
    re-fetches anything older than `extract_max_age_hours` (6); `--fresh`
    forces it. flash's article-body extracts are unaffected.
  Suggested rule: rewrite each of the three to point at the command rather
  than at the agent's memory — a rule that depends on remembering to run a
  query failed twice in the week of 16 Aug by the retro's own account.

- **2026-08-17 — the calendar dev task is a phantom; it was never broken.**
  Both the 9 Aug and 16 Aug retros report "calendar feed dark (0 events/14d)"
  and carry it forward as a maintenance item. Reconstructing the events table
  on the host at each retro's exact start time: 14 events (2 Aug), 19 (9 Aug),
  21 (16 Aug), all High/Medium within the next 14 days. The weekly batches
  landed at 09:17Z and 10:00Z; the retros ran at 16:00Z. Suggested rule: the
  claim was asserted from narrative memory rather than by running
  `jamasp calendar` — the same failure mode heuristic #14 names, applied to
  infrastructure instead of a price level. Verify a "broken" component by
  running it in the same run that reports it.

- **2026-08-17 — the real calendar limitation is a horizon, not an outage.**
  `ff_calendar` fetches `ff_calendar_thisweek.json` only, so the window can
  never exceed ~7 days while `calendarview.render` labels its output "next
  14d". `ff_calendar_nextweek.json` returns 404, so a true 14-day horizon
  needs a different source. Suggested rule: file this as the actual open item
  and drop the phantom.

- **2026-08-17 — Khamenei's death was not a coverage blind spot** (Saman,
  17 Aug). The 2 Aug retro lists it among feed failures alongside the Jordan
  and Damietta strikes. It is a long-past event, so a three-day-old news
  archive was never going to carry it. Suggested rule: correct the 2 Aug
  blind-spot list — the Jordan missile attack and Damietta FSRU strike stand
  (both moved Brent >8% intraday, both inside the archive's window); the
  Khamenei item does not, and shouldn't be cited as evidence for a source gap.

- **2026-08-17 — approved: gcaptain, an Iranian-press feed, and an incident
  feed for #9** (Saman, 17 Aug). The gcaptain proposal had been re-raised
  three weeks running with no channel to reach a dev session; the answer is
  yes. Iranian press and the #9 incident feed need per-feed fetch/extract
  verification from the host first, as in the 31 Jul source research.
  Suggested rule: once they land, #4's manual half and #9's workaround
  scoping both narrow — revisit their wording then.

- **2026-08-21 — a trajectory note asserted from memory inverted same-day at
  scoring.** The 20 Aug stance carried `a64b23c1` (new Houthi attack claim,
  0.8) as "MISS trajectory" while the scoring event — Saree's 19 Aug
  statement (*Wafa*, eighth tanker, nine ops incl Jizan) — was already in the
  DB as the Mehr item published 19 Aug 20:14Z, and on gcaptain's front page.
  The close-out scored it HIT ~22h later. Heuristic #14 names this failure
  for level-claims (status from the DB, not narrative memory); event-claims
  have the same fix. Suggested rule: extend #14 — an on-track/miss-track note
  on an event-prediction requires one keyword query over `items` since claim
  creation, or omit the note.

- **2026-08-21 — rule #16 worked end-to-end; the residual gap is feed
  coverage, not process.** Fresh-forced index fetches plus dating the Saree
  statement from a second outlet's own dateline (Mehr publish 19 Aug 20:14Z,
  "on Wednesday") pinned the event date without any gcaptain dateline — no
  stale-cache or pattern-match trap fired this time. But the gcaptain article
  itself never entered ingest on a day the feed captured 13 other gcaptain
  items (filed as docs/todo/005), so the `?s=` search sweep was the only net
  that caught it. Suggested rule: while 005 is open, a corridor-focused run
  asserting what the maritime press does or doesn't carry sweeps gcaptain
  search, not just ingested items — an extension of #4's spirit.
