---
id: 007
title: Brief skill's 0.7 confidence ceiling conflicts with playbook rule-11's 0.8 floor
status: open
opened: 2026-08-23
owner: unassigned
closed:
---

## Problem

`.claude/skills/brief/SKILL.md:82` instructs: "Cap `--confidence` at 0.7 (a
news read never justifies more)." Playbook heuristic 11 requires
structural-negative claims ("no co-confirmed text / no confirmation / regime
persists" backed by on-record positions) to be written at **0.8+**. Every
structural-negative claim created by a morning brief is therefore forced
non-compliant with the playbook's own floor.

## Why it matters

The structural-negative family is the desk's single most reliable claim
shape — **13/13 across 3–23 Aug** — and it is systematically underpriced,
which corrupts the weekly calibration signal (three consecutive retros have
reported "underconfident" driven mostly by this artifact). Scoring notes now
carry the workaround text "rule-11 floor 0.8 capped by brief 0.7 ceiling" as
boilerplate, which is a rule conflict being papered over in prose.

## Evidence

- The ceiling: `.claude/skills/brief/SKILL.md:82-83` (checked this sitting,
  2026-08-23).
- The floor: `state/playbook.md` heuristic 11 (evidence line: 13/13 across
  3–23 Aug at stated 0.55–0.80).
- Brief-created claims capped at 0.70 despite qualifying: `4cf94ab6`
  (created 2026-08-17T03:34Z, hit), `d9e50362` (2026-08-19T03:34Z, open),
  `fe35b77d` (2026-08-23T03:32Z, open) — all carry the cap workaround in
  their claim text.
- Scan/deepdive-created siblings correctly at 0.80 (the ceiling is
  brief-skill-only): `a64b23c1` (2026-08-13T20:37Z, hit), `bb86ccc9`
  (2026-08-21T01:08Z, open).
- Calibration: week of 23 Aug, stated-0.70 bucket went 6/6; family avg
  stated 0.70 vs observed 1.00.

## Fix

Decide the ceiling's shape (Saman's call — it exists as protection against
breathless news reads, and that protection is worth keeping for directional
claims):

- Option A: exempt rule-11-compliant structural negatives from the cap
  (allow up to 0.85 when the claim text names the on-record positions).
- Option B: drop the skill-level cap entirely and let the playbook govern
  confidence discipline.
- Either way, edit `.claude/skills/brief/SKILL.md` and remove the
  "capped by brief ceiling" boilerplate expectation from future claims.

## Done when

A brief-created structural-negative claim can carry 0.8+ without
contradicting its skill instructions, and the next retro's calibration
table no longer shows the 0.70-bucket artifact; or abandoned with a written
rationale for keeping the flat ceiling.

## Related

Playbook #11; retro reports 2026-08-16 and 2026-08-23 (calibration notes);
`state/predictions.jsonl` scoring notes for `4cf94ab6`, `cd49c313` week.
