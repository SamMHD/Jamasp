# Lessons inbox

Candidate lessons from daily micro-retros and feedback; consumed (emptied)
by the weekly /retro. One bullet per lesson: date, observation, suggested rule.

- 2026-08-28: `8babc60f` printed as matured ~21h before its claim-text window
  closed (horizon_days counts whole days from creation clock-time 01:08Z, so
  maturity landed 28 Aug 01:08Z vs the stated "28 Aug 23:59Z" window) — the
  brief had to defer scoring rather than score prematurely. Suggested rule:
  when writing a claim, size horizon_days so created_at + horizon lands AT or
  AFTER the claim text's window close (round up), keeping the `matured` flag
  and the falsifier window aligned.
