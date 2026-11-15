---
id: 206
title: "`jamasp extract` cuts long pieces at a fixed cap, so the section the run needs (actionforex weekly report's gold section, a Fed speech's outlook section) never reaches the agent"
status: open
opened: 2026-11-15
owner: unassigned
closed:
---

## What happened

Two reads in one week lost the part of the document the run was after:

- 2026-11-14 (Sat brief): the Jefferson speech text from federalreserve.gov
  extracted with its outlook section cut by the extract cap.
- 2026-11-15 (Sun brief): the actionforex weekly report (posted Sat ~07:25Z)
  carried the only dated post-close FedWatch split (88.5 / 11.5 December,
  76.6% "≥50bp by January", ~90bp through Sep 2027) and the extract ended
  before its gold section. A Haiku subagent read what the cap allowed.

Playbook rule 14 (15 Nov retro) now names the Sunday brief as the weekly
report's reader via a subagent — but the subagent only sees what `extract`
returns, so the cap is the binding constraint, not the agent's context.

## What should change

One of: a `--full` (or `--max-chars N`) flag on `extract` that the brief can
pass when dispatching a subagent; a per-host cap override in config for the
hosts whose long form is routinely needed (actionforex weekly/overview pieces,
federalreserve.gov speech texts, newyorkfed.org); or section-aware extraction
that keeps `h2`/`h3`-delimited blocks whole. The first is the smallest change
and is what rule 14's subagent dispatch actually needs.

## Workaround used

Subagent reads the truncated text; the missing section is logged as "cut by
the extract cap" in the brief's sourcing-health line.
