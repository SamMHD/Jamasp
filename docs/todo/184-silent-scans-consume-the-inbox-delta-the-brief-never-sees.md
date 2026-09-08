---
id: 184
title: Silent scans mark the delta read and write nothing, so the daily brief's `inbox` only covers the last ~2h; facts noticed-but-not-alerted between briefs are lost
status: open
opened: 2026-09-08
owner: unassigned
closed:
---

## Problem

`jamasp inbox` has exactly one notion of a delta: unread items
(`jamasp inbox --help`: options are `--mark-read`, `--cap`, `--db`,
`--config-dir`; no `--since`, no `--all`, no read-state override). The
scan skill (`.claude/skills/scan/SKILL.md`, step 2) runs every 2h and on
the normal no-alert outcome does `inbox --mark-read` with **no report, no
stance edit, no note anywhere**. The brief skill
(`.claude/skills/brief/SKILL.md:16,37`) loads `jamasp inbox` and is asked
to identify "the 3–7 developments since the last brief". After a day of
silent scans, that inbox is the last ~2h of items. Everything a silent
scan read, judged non-urgent and marked read is invisible to the brief
unless it happened to reach a stance rewrite (which silent scans are
forbidden to do).

## Why it matters

- **Verified loss, this run (scan 2026-09-08 19:00Z).** The stance written
  at 04:00Z carries "reported Houthi hits on Aramco Jizan (no Aramco/SPA
  confirmation)" and lists "Aramco/SPA confirmation of Jizan/Asir" as a
  scan-carry item. The 19:00Z delta contained that confirmation via an
  investinglive relay (Saudi authorities: 73 wounded; Aramco facilities in
  Abha, Najran and Jazan plus King Khalid Air Base targeted; fires forced
  temporary suspension of some energy facilities; item `a4fce307ff8b3838`).
  It does not meet the scan's urgency test (already priced, market faded
  it: WTI failed at 94.37, gold lower on hawkish-Fed bets), so the scan
  is silent, marks it read, and the 9 Sep brief will not see it through
  `inbox`. The brief will either repeat "no confirmation" or re-derive it
  from a later item if one happens to arrive.
- **The scan carry-list is one-way.** The stance asks scans to watch ~12
  specific things; the scan skill gives a silent scan no channel to report
  "seen, not urgent" back. Anything that doesn't clear the alert bar is
  dropped, so the carry-list can only ever be answered by an alert or by
  the brief re-finding the item in its own 2h window.
- **Structural-negative claims are scored on what the brief can see.**
  Claims like `71bd8ddb` ("no confirmation of X through 8 Sep 23:59Z") are
  scored by the brief from the delta plus grep of `reports/`. A
  confirmation that landed in a silent scan's delta is exactly the kind of
  falsifier the brief would then miss — a bias toward HIT on the family
  that is already scoring 22/22 (see todo-182).

## Evidence

- `uv run jamasp inbox --help` (8 Sep 19:00Z): options `--mark-read`,
  `--cap INTEGER`, `--db TEXT`, `--config-dir TEXT`, `--help`. No time
  window or read-state flag.
- `.claude/skills/scan/SKILL.md` step 2: "If NO (the normal case): run
  `uv run jamasp inbox --mark-read`, commit … and exit. No report, no
  Telegram, no stance edit."
- `.claude/skills/brief/SKILL.md:16` loads `uv run jamasp inbox`; `:37`
  "Identify the 3–7 developments since the last brief"; `:98` mark-read.
- Scan cadence today: commits at 09:00, 11:00, 13:00, 15:00, 17:00, 19:00
  (git log), every one a silent mark-read. 19:00Z delta: 42 items, oldest
  13:15Z (a late-ingested straggler), the rest ≥16:04Z.
- Not checked: whether any brief run has ever queried `state/jamasp.db`
  directly to widen its window (the brief skill does not instruct it; no
  report grep done for this todo).
- `grep -ril "mark-read|unread delta" docs/todo/` → no prior item.

## Fix

Needs a decision (playbook/skill-owned), then a small CLI change. Options:

1. **Read-only wide window for the brief.** Add `jamasp inbox --since
   <ISO|24h>` (or `--all-since-last-brief`) that lists items regardless of
   read state without touching it; brief skill step 1 uses it alongside
   the unread delta. Cheapest; keeps scans unchanged; costs the brief
   tokens on a ~24h list (mitigate with `--cap` and tier filter).
2. **Scan hand-off note.** Allow a silent scan to append one line per
   material-but-not-urgent fact to `state/scan-notes.md` (date, item id,
   one sentence); brief step 1 reads and truncates it. Cheap, but adds a
   fourth queue to the three in this README and depends on scan judgement.
3. **Both**, with (1) as the safety net and (2) for the carry-list answers.

Whichever lands, the scan skill's step 2 wording ("No report, no Telegram,
no stance edit") should say explicitly where a seen-not-urgent carry-list
answer goes.

## Done when

The 9 Sep-style case is covered: a fact that arrives in a silent scan's
delta and answers a stance carry-list item is available to the next brief
without an alert having fired — demonstrated by a brief that cites an item
first ingested >2h before its own run. Or: abandoned with the reason that
stance carry-forward is the intended sole channel and the scan skill is
amended to say so (then the carry-list in the stance should stop asking
scans for non-urgent confirmations).

## Related

- todo-182 (matured flag / early scoring — same scoring-integrity family).
- `docs/todo/README.md` "three queues" table — this would be the fourth if
  option 2 is chosen; prefer option 1 to avoid that.
- Scan run `jamasp: scan 2026-09-08 19:00`.
