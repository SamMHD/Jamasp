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
   after four days of Gulf-press ambiguity. (Ingest proposal still pending
   with Saman.)

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
   through the cap with no war headline; `a2e9d1a8` (14 Aug) written
   compliant at 0.6.

7. **"Only X can cause Y" must enumerate and reject the third channel.**
   Before writing an only-clause, explicitly consider fiscal/debasement/
   intervention paths; if you can't reject them, drop the word "only."
   — evidence: `394dfea7` — R1 broke on stagflation data + debasement bid,
   a channel the claim's war-or-rates dichotomy never priced.

8. **One-side-sourced diplomatic deadlines slip; cap ≤0.5 and never raise
   on coverage volume.** "Official announcement by <date>" with no
   scheduled-event anchor is ≤0.5 regardless of media momentum. Scope:
   two-party deals sourced to one side; actor-controlled unilateral
   announcements sit outside (live test: `cd49c313`, closes 21 Aug).
   — evidence: 0/3 week of 9 Aug (`7fcb559d` `fb90abae` `df9a603b`);
   window slid Tue→Wed→Fri while stated confidence rose 0.50→0.60.

9. **No-incident claims require a live incident feed.** If the primary
   feed (UKMTO) is dark, scope the claim to operator/press-confirmed
   events or don't write it — absence of reports is not absence of events.
   — evidence: `aba1ae09` miss 7 Aug (UKMTO 403-dark, ADNOC confirmed 3
   vessels hit); `1d282df6` hit 14 Aug written correctly scoped.

10. **Separate trigger from target in compound claims.** A level-plus-
    mechanism claim gets scored on both; a wrong-reason hit is discounted
    in calibration, not banked.
    — evidence: `7bca8d8f` (target hit via NFP, claimed strike never came),
    `6f772055` (gap held on residual floor, not the claimed war bid).

11. **Skeptic's edge is a floor, not advice: structural-negative claims
    start at 0.8.** "No co-confirmed text / no confirmation / regime
    persists" backed by on-record positions is written at 0.8+ at
    creation; going lower requires naming the specific scheduled gate that
    justifies it.
    — evidence: 8/8 across 3–16 Aug at stated 0.55–0.76; non-compliance
    flagged twice in scoring notes the week of 16 Aug alone.

12. **Pattern extrapolation needs a live transmission mechanism.** "The
    pattern continues" claims must name what carries the pattern forward
    (a pipeline, a channel, an actor's incentive) and check it is still
    live; if the mechanism is unverified, cap at 0.6.
    — evidence: week of 16 Aug's only two misses, same shape — `9a757c1a`
    (oil→PPI passthrough; demand destruction interrupted it), `71096269`
    (naming-in-48h; info-control interrupted it) — while skeptic-side
    siblings went 4/4.

13. **Operator confirmation stands alone; namelessness downgrades detail,
    not the event.** A corridor-hit report with no operator and no name is
    echo, not event; but once an operator/state confirms, missing vessel
    names don't un-verify it — don't condition event-status on naming.
    — evidence: `0aaec9a2` hit (nameless + operatorless 11 Aug report never
    verified); `71096269` miss (three ADNOC-confirmed hits nameless 60h+).

14. **Level-claim status comes from the DB, not narrative memory.** Any
    run asserting a live level-prediction's status (on-track/miss-track)
    queries the DB max/min over the claim window first — one SQL query.
    — evidence: `e3a35539` tagged 4501.8 at 13 Aug 00:35Z in the Asia
    overnight; three consecutive runs called it untagged from memory.

15. **Data-event runs: schedule ≥40 min post-print; never exit quietly on
    missing inputs.** A deepdive that finds its inputs absent reschedules
    itself via `wakeup add` and still commits — a silent exit-0 run is
    invisible to alerting.
    — evidence: 12 Aug CPI deepdive ran 12:45Z on a 12:30Z print, found
    nothing, exited "ok"; desk got its post-CPI read ~3h late.

16. **Trust an extract only as of its `fetched_at`.** Before using any
    index/section-page extract, check `extract_cache.fetched_at` for that
    URL (bust stale entries with a query-param variant); date agency copy
    inside extracts from its own dateline, never from placement.
    — evidence: 16 Aug — AJ Saudi index served a 13 Aug snapshot as fresh;
    July-9 Reuters "standstill" wire pattern-matched the live tape and was
    caught only by its dateline.
