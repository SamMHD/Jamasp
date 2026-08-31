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
- 2026-08-31: the maturity-vs-window mismatch recurred at scale — 4 of the 8
  claims flagged "matured" by `predictions due` (`d9e50362` `f73172f8`
  `6f8b0433` `2d9fac65`) had claim-text windows still open (23:59Z same day),
  and the wakeup task text propagated the error as "score ALL 8." Same root
  cause as the 28 Aug entry; adds a second surface: run-task text written
  from the `matured` flag inherits the miscount. Suggested rule: any task or
  stance line enumerating claims to score must be derived from claim-text
  window closes, not from the `matured` flag.
- 2026-08-31: `98bbfd33` (Sept-hike odds stay <50%) MISSED on Warsh's tone
  alone — both of the claim's named gates (explicit Sept guidance, hot data)
  stayed shut, and CME pricing still cleared 56%. Its companion `1a08ec53`
  (no explicit leaning) HIT the same afternoon. Suggested rule: a
  market-pricing threshold claim must not borrow confidence from the absence
  of official guidance — pricing can reprice on diagnosis/tone; enumerate
  "hawkish tone without guidance" as its own channel when writing odds
  claims (rule-7 shape: the third channel was real).
