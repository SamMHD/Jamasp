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

4. **Chokepoint and shipping claims go through the maritime trade press —
   and, while todo-005 is open, through gcaptain search, not just ingest.**
   Check a maritime trade source before concluding from general news; any
   assertion about what the maritime press does or doesn't carry sweeps
   gcaptain `?s=` (date-check mandatory) rather than trusting the feed.
   — evidence: 2 Aug gcaptain resolved who-restricts-Hormuz in one pass;
   19 Aug the RSS missed the campaign-defining Wafa article while
   ingesting 13 other gcaptain items (todo-005); feed expansion approved
   by Saman 17 Aug (todo-008).

5. **Write the flip condition with the call, then honor it.** Every
   directional call carries its falsifier at creation; when the falsifier
   prints, kill the call in the same run, without renegotiation.
   — evidence: 1 Aug gap-up call killed same-morning on the 2 Aug pause;
   `f7d39052` killed same-run pre-maturity when 4185.2 printed 5 Aug.

6. **A range cap must state the controlling desk's live impulse — and in a
   confirmed trend regime, an against-trend cap needs a fresh
   counter-mechanism or isn't written.** "X desk has the wheel" justifies a
   cap only if X's current impulse points against the level (else conf
   ≤0.6). Once a breakout has held on a named flow mechanism, prefer the
   falsifiable hold-side claim; a cap without a new opposing mechanism is
   structurally disadvantaged even at 0.6.
   — evidence: `f7d39052`/`394dfea7` (5–6 Aug) broke upward through caps;
   week of 23 Aug: against-trend caps `a2e9d1a8`/`7e803666` both missed at
   compliant 0.6 while with-trend hold `3f03ae58` hit.

7. **"Only X can cause Y" must enumerate and reject the third channel.**
   Before writing an only-clause, explicitly consider fiscal/debasement/
   intervention paths; if you can't reject them, drop the word "only."
   — evidence: `394dfea7` — R1 broke on stagflation data + debasement bid,
   a channel the claim's war-or-rates dichotomy never priced.

8. **All announcement-timing claims cap at ≤0.5 unless anchored to a
   published, scheduled event.** "Official announcement by <date>" without
   a presser on the books or a statutory deadline never clears 0.5 — who
   controls the calendar doesn't matter, and coverage volume never raises
   it. (Actor-controlled carve-out removed after failing its live test.)
   — evidence: 0/3 week of 9 Aug (`7fcb559d` `fb90abae` `df9a603b`);
   `cd49c313` (single-actor, self-scheduled) still slipped Fri→Mon, missed
   at 0.6 on 21 Aug.

9. **No-incident claims require a live incident feed.** If the primary
   feed (UKMTO) is dark, scope the claim to operator/press-confirmed
   events or don't write it — absence of reports is not absence of events.
   Incident-feed wiring approved 17 Aug (todo-008); rescope when it lands.
   — evidence: `aba1ae09` miss 7 Aug (UKMTO 403-dark, ADNOC confirmed 3
   vessels hit); `1d282df6` hit 14 Aug written correctly scoped.

10. **Separate trigger from target in compound claims.** A level-plus-
    mechanism claim gets scored on both; a wrong-reason hit is discounted
    in calibration, not banked.
    — evidence: `7bca8d8f` (target hit via NFP, claimed strike never came),
    `6f772055` (gap held on residual floor, not the claimed war bid).

11. **Skeptic's edge is a floor, not advice: structural-negative claims
    start at 0.8.** "No co-confirmed text / no confirmation / regime
    persists" backed by on-record positions is written at 0.8+ at creation;
    going lower requires naming the specific scheduled gate that justifies
    it. The brief skill's 0.7 ceiling currently blocks compliance in
    briefs (todo-007) — until resolved, name the compliant floor in the
    claim text so calibration can correct for the cap.
    — evidence: 13/13 across 3–23 Aug at stated 0.55–0.80; 5/5 week of
    23 Aug at 0.70, three claims explicitly ceiling-capped.

12. **Pattern extrapolation needs a live transmission mechanism.** "The
    pattern continues" claims must name what carries the pattern forward
    (a pipeline, a channel, an actor's incentive) and check it is still
    live; if the mechanism is unverified, cap at 0.6.
    — evidence: week of 16 Aug's only two misses (`9a757c1a` `71096269`)
    lacked a checked mechanism; `a64b23c1` (declared campaign + weekly
    cadence, 0.8) is the compliant affirmative shape — hit 21 Aug.

13. **Operator confirmation stands alone; namelessness downgrades detail,
    not the event.** A corridor-hit report with no operator and no name is
    echo, not event; but once an operator/state confirms, missing vessel
    names don't un-verify it — don't condition event-status on naming.
    — evidence: `0aaec9a2` hit (nameless + operatorless 11 Aug report never
    verified); `71096269` miss (three ADNOC-confirmed hits nameless 60h+).

14. **Status claims come from running the check, never from narrative
    memory — levels, events, and infrastructure alike.** Level/event
    trajectory notes: `jamasp predictions due --open` (per-claim window
    high/low) or one keyword query over `items` since claim creation, or
    omit the note. A component reported broken must have been run, broken,
    in the same run that reports it.
    — evidence: `e3a35539` called untagged for 3 runs after the 4501.8
    print; `a64b23c1` carried "MISS trajectory" while the scorer sat in
    the DB (20 Aug); calendar "outage" carried by three retros, disproven
    both times `jamasp calendar` was actually run (17 + 23 Aug).

15. **Data-event runs: schedule ≥40 min post-print; a run that finds its
    inputs missing reschedules via `wakeup add` and still commits.**
    `jamasp run` now records exit-0-with-no-commit as status `empty` and
    Telegrams the desk (dispatched wakeups stay pending), so silent empty
    runs are visible — the scheduling discipline is the half that remains
    manual.
    — evidence: 12 Aug CPI deepdive ran 12:45Z on a 12:30Z print, exited
    "ok", desk got its read ~3h late; detection tooling landed 17 Aug.

16. **Date agency copy from its own dateline, and trust extracts only as
    of the freshness header.** `extract` now prints `fetched_at`/age and
    re-fetches cache older than 6h (`--fresh` forces) — read the header.
    The dateline discipline stays manual: a wire story's placement is not
    its date.
    — evidence: 16 Aug AJ index served a 13 Aug snapshot + July-9 Reuters
    wire pattern-matched the live tape; 19–21 Aug Saree statement
    dateline-pinned via Mehr with no trap fired.

17. **A scheduled-date anchor needs primary verification ≤7 days old.**
    Any wakeup or stance framing anchored to a data/event date cites a
    calendar-feed row or fresh extract from within 7 days of firing —
    "~date" chatter never hardens into an anchored wakeup. The Saturday
    brief re-verifies the coming week's map.
    — evidence: three hand-built date errors in ten days — FOMC minutes
    (19th vs 20th), Warsh (21st vs 28th), core PCE (26th vs 28th, caught
    22 Aug); Bessent slot discrepancy (16:00Z wakeup vs 18:00Z feed row)
    caught by the 23 Aug retro's calendar check.

18. **A falsifier must be scoreable from observable-at-will state or a
    committed-schedule release.** Never anchor scoring on an irregular
    third-party publication whose cadence nobody controls; and any metric
    built on adversary-controllable telemetry (AIS/tracking) carries an
    is-the-instrument-still-valid check before use — actors with an
    incentive to go dark eventually do.
    — evidence: `599d9586` UNCLEAR 23 Aug — UKMTO weekly relay never
    printed, and 80% of Hormuz transits went deliberately AIS-dark
    mid-window (Kpler; DoE actual flow ~2x tracked). Metric retired.
