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

## 4.5 File code gaps as todos, don't re-raise them

Any finding that needs a **code, config or ops** change — a source to wire, a
parser to write, a threshold to revisit — goes in `docs/todo/` as a file (see
the `todos` skill), not only into the report and not only into the Telegram
summary. Check `grep -lE '^status: (open|in-progress)' docs/todo/[0-9]*.md` first
and append to an existing item rather than opening a second one.

The 2, 9 and 16 Aug 2026 retros each re-raised the same `config/sources.yaml`
gap in a Telegram line and nothing moved for three weeks. **If you are about to
write "re-raised again", write a todo file instead.** And before reporting
something as broken, run it in this same run — two of the dev tasks carried in
Aug 2026 were phantoms that survived on restatement alone.

## 4.6 Weight fits: flags and pins

Read `state/weights.json` (written daily by `jamasp weights fit`; if it does
not exist yet, no fit has run — skip this section this week). It has one
entry per fit under `fits`, each with a `flags` list and a `coefficients`
map.

Walk the **`theme`** fit's `flags` for any `negative:<column>` entry. A
negative coefficient there means items scored bullish on that theme were
followed by gold going DOWN — evidence the **direction scoring** for that
theme is wrong, not that the theme should shrink. This is the single most
useful thing the regression can report, and reading it is the retro's job;
the fit only flags it. A finding here belongs in the report's Playbook
changes section with its evidence line, same as anything else this retro
changes.

**Ignore `technical`-fit flags for this purpose.** Measured on a synthetic
730-day random walk at production scale, Fit A throws 23 `negative:` flags
out of 38 columns — 38 weak predictors against a near-random-walk target
produce noise at that rate as a matter of course. The diagnostic claim above
is really about Fit B's six theme columns, the ones with an actual causal
story (published direction) behind them. Treat every `technical` `negative:`
flag as expected noise; chasing all 23 wastes a retro that has one real
signal to find, in `theme`.

While you're in `config/weights.yaml`, check the `pins:` block for anything
expiring within 7 days: renew it (new `expires`, reason updated if it
changed) or let it lapse on purpose — either is fine, silently forgetting it
is not. `jamasp/config.py`'s `active_pins()` already refuses a pin with no
`reason` or no `expires` at load time; this is the human side of that same
discipline, catching a stale pin before the calendar does it for you.

## 5. Deliver + close out

- Persian summary of the scorecard (≤8 lines) → `uv run jamasp notify -`.
- `git add -A reports/ state/ docs/todo/ config/ && git commit -m "jamasp: retro YYYY-MM-DD"`.
  `config/` is new here: it is the only place a pin edited in §4.6 gets
  committed, and a retro that touched `config/weights.yaml` but never staged
  `config/` would leave that edit uncommitted at the end of every run.

Phase 3 (not yet): source-quality analysis and gated self-edit proposals on
a branch. Do not attempt them.
