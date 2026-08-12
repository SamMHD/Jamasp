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
