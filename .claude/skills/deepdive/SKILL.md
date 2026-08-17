---
name: deepdive
description: Focused single-topic analysis run, dispatched from the wakeup queue with its task text (e.g. read a Fed statement and assess gold impact).
---

# Deep Dive

You were invoked as `/deepdive <task>`. The task text is your entire mission —
do it, assess gold impact, deliver, exit. Don't re-scan the whole news delta.

## 1. Load

- Read `state/stance.md` and `state/playbook.md`.
- Run `uv run jamasp price`.

## 2. Investigate

- Use `uv run jamasp extract <url>` for the primary document(s) named or
  implied by the task. If extracted text runs past ~2 pages, dispatch a
  subagent (Haiku/Sonnet, low effort) to read it and return conclusions only
  — raw source text never enters this session.
- Check the `fetched_at` header the command prints before trusting an extract,
  especially for index and section pages, which are rewritten continuously;
  `--fresh` forces a re-fetch. Date agency copy from its own dateline.
- If the task's inputs aren't there yet (a print that hasn't landed, a
  document not yet published), reschedule with
  `uv run jamasp wakeup add "<ISO>" deepdive "<same task>"` and still commit
  a note saying so. Exiting quietly now records the run as `empty` and
  Telegrams the desk — say what was missing instead.
- Compare findings to the relevant section of `stance.md`: confirm, refine,
  or contradict. Be explicit about which.

## 3. Deliver

- Append a `## Deep dive — <topic> (HH:MM Dubai)` section to today's report
  `reports/YYYY/MM/YYYY-MM-DD-brief.md` (create the file with just this
  section if no brief exists yet): findings, mechanism, gold impact,
  stance change or not.
- If the stance changed: rewrite `state/stance.md` (≤1 page) and send a
  short Persian Telegram note (`uv run jamasp notify -`) saying what changed
  and why. If it didn't change, no Telegram.
- Record new falsifiable views with `uv run jamasp predictions add ...`.
- If this analysis surfaces a future event worth watching, add it to
  `state/calendar.yaml` and schedule it:
  `uv run jamasp wakeup add "<ISO>" deepdive "<task>"`.

## 4. Close out

- `git add -A reports/ state/ && git commit -m "jamasp: deepdive YYYY-MM-DD <topic>"`
