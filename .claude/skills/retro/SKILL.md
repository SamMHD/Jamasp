---
name: retro
description: Weekly deep learning run (Sunday) — calibration scorecard from the week's scored predictions, playbook rewrite from evidence, lessons-inbox consumption.
---

# Weekly Retro

The learning run. Markets are closed; take the long view. This is the ONLY
run allowed to rewrite `state/playbook.md`.

## 1. Load

- Read `state/playbook.md`, `state/lessons-inbox.md`, `state/stance.md`.
- Run `uv run jamasp predictions list` and `uv run jamasp predictions due`.
- Score anything still due (judge against the annotated price move):
  `uv run jamasp predictions score <id> --outcome hit|miss|unclear --note "<why>"`.

## 2. Scorecard report

Write `reports/YYYY/MM/YYYY-MM-DD-retro.md`:

    # Jamasp Retro — week ending YYYY-MM-DD

    ## Scorecard
    <this week's scored predictions: claim, confidence, outcome. Hit rate
    overall and by claim type (rates/dollar/geopolitics/flows). Where am I
    reliably right? Where do I overweight noise?>

    ## Calibration notes
    <compare stated confidence to observed hit rate; name one concrete bias>

    ## Playbook changes
    <bullet list: promoted / revised / pruned heuristics, each with the
    evidence line that justifies it>

## 3. Rewrite the playbook

Rewrite `state/playbook.md` in full (never append-only):
- Promote lessons from `lessons-inbox.md` that this week's evidence supports.
- Prune heuristics disproven or unused for 4+ weeks.
- Hard cap: 25 heuristics / one page. Every heuristic carries a one-line
  evidence note (`— evidence: <dates/outcomes>`).
- Then empty `state/lessons-inbox.md` (consumed), leaving its header.

## 4. Address human feedback

Search the week's Telegram feedback forwarded into the repo (grep
`reports/` and `state/lessons-inbox.md` for `feedback:` entries). Every
piece of feedback from Saman gets an explicit response in the retro report:
adopted (how) or declined (why).

## 5. Deliver + close out

- Persian summary of the scorecard (≤8 lines) → `uv run jamasp notify -`.
- `git add -A reports/ state/ && git commit -m "jamasp: retro YYYY-MM-DD"`.

Phase 3 (not yet): source-quality analysis and gated self-edit proposals on
a branch. Do not attempt them.
