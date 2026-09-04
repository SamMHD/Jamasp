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
- 2026-09-03 (deepdive #50): `c2eafbf8` (additional mine strike by 7 Sep)
  was written with "UKMTO/operator/maritime-press reported OR IRGC-claimed"
  as the trigger. The IRGC's 2 Sep claim (two tankers "on an unauthorized
  route", "currently on fire", no names/positions; Mehr relay only) satisfies
  the literal wording while CENTCOM denied the sibling 31 Aug claim, UKMTO
  relayed nothing and ISW/Gulf News frame both as infowar. A claim that
  counts adversary information ops as its own trigger cannot miss and cannot
  inform. Suggested rule (rule-13/18 shape): incident-count claims score on
  UKMTO/operator/host-state confirmation only; adversary claims are a
  separate, explicitly-labelled "claims cadence" metric if tracked at all.
  Score `c2eafbf8` per wording at maturity but discount it in calibration.
- 2026-09-04 (brief): `031e3470` (no settle >4457 thru 3 Sep, 0.65) missed
  because its "no dovish catalyst scheduled before payrolls" premise
  enumerated only scheduled DATA (ADP/claims/ISM) and not scheduled FOMC
  SPEAKERS — Waller (voting governor) was on the 3 Sep tape and repriced
  Sept-hike odds 63-66% -> 48-50% in one session, flipping the controlling
  desk's impulse the day the cap was tested. Suggested rule (rule-6/7
  shape): a "no catalyst in window" premise must list scheduled Fed
  speakers (and their known lean) as catalysts alongside data; a cap whose
  window contains a governor/chair speech either names the speaker's
  expected lean as consistent with the cap or is capped at 0.55.
- 2026-09-04 (brief): `b6450c7a` (no USDJPY daily close <157 thru 4 Sep,
  0.65) missed 1.2 yen through the line. Two nameable causes: (a) it priced
  one break channel (MoF intervention) and ignored BoJ-side hawkish talk +
  Japan data and a US-side dovish repricing — rule-7 third channel again,
  now on an FX pillar; (b) structural thinness — the falsifier sat ~1.4%
  from spot over a 10-day window in a pair running >1% daily ranges.
  Suggested rule: a level-hold claim needs falsifier distance of at least
  ~1.5x the window's expected range (daily ATR x sqrt(days)) or it is not
  written above 0.55; and FX-pillar claims enumerate both central banks'
  channels, not just the intervention one.
- 2026-09-04 (deepdive #42): `16085af9` (Sept-hike odds >=60% immediately
  before the 4 Sep print, 0.6) missed at 50% — second instance in two days
  of the 031e3470 shape: the claim's risk list named data and a de-risking
  fade but not the scheduled FOMC-speaker slate, and Waller's 3 Sep HOLD
  lean did the repricing (63-66% -> 48-50%) with no data at all. Pair it
  with `98bbfd33` (odds <50% thru payrolls, 0.7) which missed the OTHER way
  on Warsh's 28 Aug tone: two odds-threshold claims across an FOMC-speaker
  window, both broken by tone rather than data, one in each direction.
  Suggested rule: an odds-level or odds-direction claim spanning any
  governor/chair appearance is capped at 0.55 unless the speaker's known
  lean is named as consistent with the claim.
- 2026-09-04 (deepdive #42, retry): attempt 1 (run 364, 13:15:01-13:19:11Z)
  scored `16085af9` and wrote the lesson above, then exited `empty` — no
  report section, no stance, no commit. The odds relay had not landed
  (the first CME number surfaced ~13:20Z on actionforex's FRONT PAGE, ~50
  min post-print, and in no ingested item) and instead of rescheduling per
  rule 15 the run just stopped; the retry inherited the uncommitted
  DB/JSONL/lessons writes only because both ran in the same working tree.
  Two suggested sharpenings: (a) rule 15 — a data-event run that has
  already written state must commit a "partial, inputs pending" note or
  reschedule; an `empty` exit after state writes is the worst of both
  (todo-180 for the wrapper side); (b) print+45 is too tight for the
  ODDS leg of a data-event read — our feeds relay CME ~45-60 min after
  the print. Schedule print+60, or write the read from the 2y move and
  hand the odds number to the NY-close scan.
