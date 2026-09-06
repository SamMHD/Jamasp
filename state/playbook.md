# Playbook

Earned heuristics only — rewritten weekly by /retro, never by other runs.
Cap: 25 heuristics, one page. Each carries an evidence note.
Rewritten 6 Sep 2026 (covers two weeks — the 30 Aug retro did not run).

## Heuristics

1. **Extract before asserting a geopolitical fact.** No geopolitical claim
   enters `stance.md` without extracting a source and confirming *who is
   doing what to whom* and *since when* — direction of action and start
   date are the two fields headlines most often invert or omit.
   — evidence: 30 Jul GDP/PCE listed as upcoming after it printed; 31 Jul
   Hormuz who-blockades-whom inverted; 5 Sep Mehr-only Kharg-anchorage
   strike held as single-source until CENTCOM's own account landed.

2. **Write the flip condition with the call — actor and target class
   named — then honor it, and retire a realized call.** Every directional
   call carries its falsifier at creation; kinetic triggers name the actor
   and the target class (Iranian hit on a non-Iranian hull ≠ US counter on
   an Iranian hull ≠ ordnance on Kharg/Larak infrastructure). When the
   falsifier prints, kill the call in the same run; when a call is priced
   by a move, mark it realized and cut its forward weight in the same run.
   — evidence: 1 Aug gap-up killed same-morning; `f7d39052` killed
   pre-maturity 5 Aug; `98bbfd33` killed same-run 31 Aug on CME 56%; 5 Sep
   scan could not tell whether a US tanker strike at Kharg anchorage was
   the "hull strike" trigger — 6 Sep brief rewrote the flip line;
   "hawkish dissent underpriced" (31 Jul) paid 1 Aug and was retired.

3. **Gold ignoring its own news names the price-setter — not the
   direction.** Repeated non-response to a textbook driver identifies the
   marginal price-setter; it says nothing about which way that desk will
   push. Reading "rates desk in control" as "range-bound" is the error.
   — evidence: 3 Aug fade family hit right-reason on the rates-session
   break; misread as a cap it produced `f7d39052`/`394dfea7` (Aug) and
   `031e3470` (2 Sep: "war failed to lift gold" → cap → broke next session
   when the rates desk's own impulse flipped on Waller).

4. **Chokepoint and shipping claims go through the maritime trade press —
   and, while todo-005 is open, through gcaptain search, not just ingest.**
   Any assertion about what the maritime press does or doesn't carry
   sweeps gcaptain `?s=` (date-check mandatory) rather than trusting the
   feed.
   — evidence: 2 Aug gcaptain resolved who-restricts-Hormuz in one pass;
   19 Aug the RSS missed the campaign-defining Wafa article (todo-005);
   24 Aug `bb86ccc9` scored same-day on gcaptain + Maritime Executive;
   feed expansion approved 17 Aug (todo-008).

5. **A range cap must state the controlling desk's live impulse, survive
   nothing scheduled inside its window that can flip that impulse, and —
   in this trend regime — a gold cap is not written above 0.5 until one
   hits.** "X desk has the wheel" justifies a cap only if X's current
   impulse points against the level *and* no speaker/data inside the window
   is likely to reverse it. Prefer the falsifiable hold-side claim.
   — evidence: gold caps 0/5 since 5 Aug (`f7d39052` `394dfea7` `a2e9d1a8`
   `7e803666` `031e3470` — the last compliant on paper, killed by a
   governor speech inside its window); gold floors/holds 4/4 (`1ee59e17`
   `3f03ae58` `9b2f3adf` `2ef33025`); non-gold caps with a supply/flow
   mechanism 2/2 (`b0c2bfeb` `6f8b0433`).

6. **"Only X can cause Y" must enumerate and reject the third channel —
   and the third channel has a name per claim family.** Fiscal/debasement/
   intervention for gold; *tone without guidance* for Fed pricing; the
   *other* central bank for FX pillars. If you can't reject it, drop "only."
   — evidence: `394dfea7` (debasement bid); `98bbfd33` (Warsh diagnosis,
   zero guidance, CME 56%); `b6450c7a` (priced MoF intervention, broke on
   BoJ hawks + US dovish repricing).

7. **Announcement-timing claims — and claims about how an actor will
   publicly frame an action — cap at ≤0.5 unless anchored to a published,
   scheduled event.** Who controls the calendar doesn't matter; coverage
   volume never raises it.
   — evidence: 0/4 lifetime (`7fcb559d` `fb90abae` `df9a603b` `cd49c313`);
   `55412a56` missed at a compliant 0.5 (designation became a proposed
   rulemaking); `8babc60f` (Iran frames enforcement as a sanctions
   response) missed at 0.6 — the action continued, the framing never came.

8. **No-incident claims require a live incident feed.** If the primary feed
   (UKMTO) is dark, scope the claim to operator/press-confirmed events or
   don't write it — absence of reports is not absence of events. Rescope
   when todo-008 lands.
   — evidence: `aba1ae09` miss 7 Aug (UKMTO dark, ADNOC confirmed 3 hits);
   `1d282df6` hit 14 Aug written correctly scoped.

9. **Separate trigger from target in compound claims.** A level-plus-
   mechanism claim is scored on both; a wrong-reason hit is discounted in
   calibration, not banked.
   — evidence: `7bca8d8f`, `6f772055` (wrong-reason hits, Aug);
   `9b2f3adf` (26 Aug) and `2ef33025` (5 Sep) scored right-reason with the
   mechanism observed.

10. **Skeptic's edge is a floor: structural-negative claims start at 0.8.**
    "No co-confirmed text / no confirmation / regime persists" backed by
    on-record positions is written at 0.8+; going lower requires naming
    the scheduled gate that justifies it. The brief's 0.7 ceiling
    (todo-007) still blocks compliance — name the compliant floor in the
    claim text so calibration can correct.
    — evidence: 22/22 across 3 Aug–1 Sep; 9/9 this fortnight at avg 0.76,
    five of them ceiling-capped at 0.7.

11. **Pattern extrapolation needs a live transmission mechanism — and a
    horizon >14 days re-verifies it at the midpoint.** "The pattern
    continues" names what carries it forward and checks it is still live
    (else cap 0.6); a long-horizon claim whose mechanism has died is killed
    at the midpoint check (rule 2), not left to mature on a stale premise.
    — evidence: `9a757c1a` `71096269` misses (no mechanism); `a64b23c1`,
    `bb86ccc9` hits at 0.8 (declared campaign + weekly cadence);
    `951d8286` (3 Aug premise, 29-day horizon) missed by zero margin 1 Sep
    after the Hormuz war rewrote its input-cost mechanism.

12. **Operator confirmation stands alone; namelessness downgrades detail,
    not the event; adversary claims are never a trigger.** A nameless,
    operatorless corridor report is echo; once an operator/host state
    confirms, missing names don't un-verify it. Incident-count claims score
    on UKMTO/operator/host-state confirmation only — IRGC/Houthi claims are
    a separate, labelled "claims cadence" metric if tracked at all.
    — evidence: `0aaec9a2` hit, `71096269` miss (Aug); `c2eafbf8` (31 Aug)
    wrote "OR IRGC-claimed" into its trigger and the CENTCOM-denied 2 Sep
    claim satisfies it — a claim that cannot miss cannot inform.

13. **Status claims come from running the check, never from narrative
    memory — levels, events, and infrastructure alike.** Level/event notes
    come from `jamasp predictions due --open` or a keyword query since
    claim creation, or are omitted. A component reported broken must have
    been run, broken, in the same run that reports it.
    — evidence: `e3a35539`, `a64b23c1` (Aug); calendar "outage" carried by
    three retros, and "feed ends 4 Sep" carried into Sunday 6 Sep — false
    every time `jamasp calendar` was run; "`bars` empty (todo-009)" carried
    in the 6 Sep stance and a 4 Sep scoring note while the table held
    11,742 rows.

14. **Data-event runs: schedule the odds leg at print+60, ≥40 min for the
    print itself; a run that has written state and finds inputs missing
    commits a "partial, inputs pending" note or reschedules via
    `wakeup add` — never exits `empty` after writing.** `jamasp run` records
    exit-0-with-no-commit as `empty` and notifies the desk; the discipline
    of not leaving orphaned writes is the manual half (todo-180).
    — evidence: 12 Aug CPI deepdive ran at print+15 and exited "ok" with
    nothing; 4 Sep NFP deepdive attempt 1 scored `16085af9`, wrote a lesson,
    then exited `empty` uncommitted — first CME odds relay surfaced ~50 min
    post-print on actionforex's front page, in no ingested item.

15. **Date agency copy from its own dateline; trust extracts only as of
    the freshness header; check the extracted title against the headline
    you asked for.** `extract` prints `fetched_at`/age and re-fetches cache
    older than 6h; a wire story's placement is not its date; a body that
    doesn't match its headline is a mis-serve, not a scoop.
    — evidence: 16 Aug AJ index served a 13 Aug snapshot; 19–21 Aug Saree
    statement dateline-pinned via Mehr; 6 Sep Gulf News URL served an
    unrelated article body (todo-181).

16. **A scheduled-date anchor needs primary verification ≤7 days old.** Any
    wakeup or stance framing anchored to a data/event date cites a
    calendar-feed row or fresh extract from within 7 days; "~date" chatter
    never hardens into an anchored wakeup. The Saturday brief re-verifies
    the coming week.
    — evidence: three hand-built date errors in ten days (Aug: FOMC
    minutes, Warsh, core PCE); Bessent slot discrepancy caught 23 Aug;
    #41 buyback carried as UNVERIFIED, #51/#26 re-verified against feed
    rows 6 Sep.

17. **A falsifier must be scoreable from observable-at-will state or a
    committed-schedule release.** Never anchor scoring on an irregular
    third-party publication; adversary-controllable telemetry (AIS) carries
    an is-the-instrument-valid check — actors with an incentive to go dark
    eventually do.
    — evidence: `599d9586` UNCLEAR 23 Aug (UKMTO relay never printed, 80%
    of transits AIS-dark; metric retired); `73281b56` hit 1 Sep as a
    *ceiling* on the same count — darkness only pushes it one way.

18. **Align the horizon with the claim-text window.** Size `horizon_days`
    so `created_at + horizon` lands at or after the window close (round
    up); any "claims to score" list — stance, wakeup task, brief — derives
    from claim-text windows, never from the `matured` flag; a no-event
    claim scores only at window close.
    — evidence: `8babc60f` flagged matured ~21h early (28 Aug); 4 of 8
    "matured" claims on 31 Aug had open windows and the wakeup text said
    "score ALL 8"; `b6794dbb` (23 Aug) and `fe35b77d` (6 Sep) correctly
    deferred. todo-182.

19. **A Fed-pricing threshold claim spanning a governor/chair appearance
    is capped at 0.55 unless the speaker's known lean is named as
    consistent with the claim.** A "no catalyst in window" premise lists
    scheduled Fed speakers beside data; repricing on tone alone, with no
    data, is the base case, not the tail.
    — evidence: 0/3 in eight days — `98bbfd33` (<50%, Warsh tone 28 Aug),
    `021357a6` (<65%, Barr + Warsh follow-through 1 Sep), `16085af9`
    (≥60%, Waller HOLD lean 3 Sep) — broken by tone in both directions;
    `031e3470`'s cap died the same session on the same speech.

20. **A level-hold line sits ≥ ~1.5× the window's expected range from spot
    (daily ATR × √days) or is not written above 0.55.** FX-pillar claims
    enumerate both central banks' channels, not just intervention.
    — evidence: `b6450c7a` (USDJPY ≥157, line 1.4% away over ten days in a
    pair running >1% daily) missed by 1.2 yen; open `a1fc647f` (4425
    floor, 51 pts from spot on ATR 113, one day, 0.65) is the same shape,
    flagged for calibration.
