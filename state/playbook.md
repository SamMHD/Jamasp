# Playbook

Earned heuristics only — rewritten weekly by /retro, never by other runs.
Cap: 25 heuristics, one page. Each carries an evidence note.

## Heuristics

1. **Extract before asserting a geopolitical fact.** No geopolitical claim
   enters `stance.md` without extracting a source and confirming *who is
   doing what to whom* and *since when* — direction of action and start
   date are the two fields headlines most often invert or omit.
   — evidence: 30 Jul GDP/PCE listed as upcoming after it printed; 31 Jul
   Hormuz who-blockades-whom inverted; both corrected only after extraction.

2. **A realized call is spent — don't re-bank it.** When a stance item is
   priced by a move, mark it realized and cut its forward weight in the
   same run.
   — evidence: "hawkish dissent underpriced" (31 Jul) paid 1 Aug and was
   retired rather than carried.

3. **Gold ignoring its own news names the price-setter — not the
   direction.** Repeated non-response to a textbook driver identifies the
   marginal price-setter; it says nothing about which way that desk will
   push. Reading "rates desk in control" as "range-bound" is the error.
   — evidence: confirmed 3 Aug — fade family (`dc38b83f` `78a3c1ab`
   `1438e2a6`) hit right-reason on the rates-session break; misread as a
   cap it produced the `f7d39052`/`394dfea7` misses.

4. **Chokepoint and shipping claims go through the maritime trade press.**
   Check a maritime trade source (gcaptain extracts cleanly) before
   concluding from general news — general feeds under-cover the maritime leg.
   — evidence: 2 Aug — gcaptain resolved who-restricts-Hormuz in one pass
   after four days of Gulf-press ambiguity; feed had missed the Jordan and
   Damietta strikes entirely. (Ingest proposal still pending with Saman.)

5. **Write the flip condition with the call, then honor it.** Every
   directional call carries its falsifier at creation; when the falsifier
   prints, kill the call in the same run, without renegotiation.
   — evidence: 1 Aug gap-up call killed same-morning on the 2 Aug pause;
   `f7d39052` killed same-run pre-maturity when 4185.2 printed 5 Aug.

6. **A range cap must state the direction of the controlling desk's live
   impulse.** "X desk has the wheel" justifies a cap only if X's current
   impulse points against the level; if the impulse is gold-positive, cap
   confidence ≤0.6 or don't record the cap.
   — evidence: `f7d39052` (5 Aug) and `394dfea7` (6 Aug) both broke upward
   through the cap with no war headline — the rates channel itself did it.

7. **"Only X can cause Y" must enumerate and reject the third channel.**
   Before writing an only-clause, explicitly consider fiscal/debasement/
   intervention paths; if you can't reject them, drop the word "only."
   — evidence: `394dfea7` — R1 broke on stagflation data + debasement bid,
   a channel the claim's war-or-rates dichotomy never priced.

8. **One-side-sourced diplomatic deadlines slip; cap ≤0.5 and never raise
   on coverage volume.** "Official announcement by <date>" with no
   scheduled-event anchor (summit, vote, court date) is ≤0.5 regardless of
   media momentum — reporting volume measures attention, not likelihood.
   — evidence: 0/3 this week (`7fcb559d` `fb90abae` `df9a603b`); the window
   slid Tue→Wed→Fri while stated confidence rose 0.50→0.55→0.60.

9. **No-incident claims require a live incident feed.** If the primary
   feed (UKMTO) is dark, scope the claim to operator/press-confirmed
   events or don't write it — absence of reports is not absence of events.
   — evidence: `aba1ae09` miss 7 Aug — ADNOC confirmed 3 vessels hit, 1
   crew killed, while UKMTO was 403-dark and the window looked "quiet."

10. **Separate trigger from target in compound claims.** A level-plus-
    mechanism claim gets scored on both; a wrong-reason hit is discounted
    in calibration, not banked.
    — evidence: `7bca8d8f` (target hit via NFP, claimed strike never came),
    `6f772055` (gap held on residual floor, not the claimed war bid).

11. **Price the skeptic's edge.** Structural-negative diplomacy claims
    ("no co-confirmed text / no confirmation / regime persists") backed by
    on-record positions deserve 0.8+, not 0.65–0.75.
    — evidence: 6/6 this week at avg stated 0.76 — systematically
    underconfident where the process is strongest.
