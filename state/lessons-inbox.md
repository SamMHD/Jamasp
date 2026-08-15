# Lessons inbox

Candidate lessons from daily micro-retros and feedback; consumed (emptied)
by the weekly /retro. One bullet per lesson: date, observation, suggested rule.

- 2026-08-12: CPI deepdive (run 130) was scheduled 12:45Z for a 12:30Z print
  — it ran before the 15-min ingest cycle had landed any CPI items, scored
  772323d6 and exited "ok" in 4.5 min with no stance rewrite, no desk note,
  no commit; the desk got its post-CPI read ~3h late via a scan-scheduled
  catch-up (#24). Suggested rules: (1) schedule data-event deepdives ≥40 min
  after the print, not 15; (2) a deepdive that finds its inputs missing must
  reschedule itself via `wakeup add`, never exit quietly; (3) every agent run
  commits, even a no-op — a silent exit-0 run is invisible to alerting.
- 2026-08-15: e3a35539 (200DMA 4501.8 tag) HIT at 13 Aug 00:35Z, but the
  13 Aug brief declared the level "untagged" ~3h AFTER the print, and the
  14 Aug brief + stance carried "miss-track" for two more runs — three
  consecutive runs asserted a level-claim's status from narrative memory
  while the falsifying print sat in the DB. The tag came in the Asia
  overnight; briefs anchored on the prior US-session high. Suggested rule:
  any run that asserts a live level-prediction's status (on-track/
  miss-track) must query the DB max/min print over the claim window first —
  the check costs one SQL query; the miss cost three runs of wrong stance
  and a pre-committed demotion built on a false premise.
