---
id: 006
title: flash/digest claude subprocess fails several times daily, silently
status: open
opened: 2026-08-21
owner: unassigned
closed:
---

## Problem

The ingest pipeline's `digest` (haiku) and `flash` (sonnet) `claude -p`
subprocesses fail intermittently — 24 logged failures 14–20 Aug, peaking at 8
on 18 Aug — and the failures land only in `source_errors`, which nothing
watches.

## Why it matters

Flash runs inside the 15-minute ingest timer; each failed pass is a cycle
where a top-tier gold item posts to the news channel late or not at all.
These errors are caught in-process, so the unit presumably still exits 0 and
the `OnFailure=jamasp-alert@` path — built precisely so failures don't sit
silently in a journal — never fires. (Not verified from this run whether
ingest exit status is in fact 0 on these cycles; no ingest failure notice was
seen in the desk chat this week.)

## Evidence

- `SELECT COUNT(*) FROM source_errors WHERE source IN ('flash','digest') AND
  ts >= '2026-08-14'` → 24 (checked 2026-08-21T01:05Z). Daily: 14th 2, 15th
  2, 16th 0, 17th 3, 18th 8, 19th 5, 20th 4.
- Two error shapes: (a) `CalledProcessError` on the `claude -p` command —
  e.g. flash 2026-08-20T00:15:31Z — with the exit status truncated out of the
  stored string; (b) JSON parse failure "Extra data: line 5 column 1 (char
  134)" (flash 2026-08-19T04:46:28Z), i.e. the model emitted text around the
  JSON.
- Not checked: correlation with batch size, timeouts, or rate limits — the
  `error` column truncates the message; the journal has the full trace.

## Fix

(a) Store exit status + stderr tail in `source_errors`; (b) harden the
output parse for shape (b) (strict JSON output format, strip pre/post-amble);
(c) decide whether N consecutive flash failures should reach the desk via the
existing `jamasp-alert@` path rather than only the DB.

## Done when

A representative week shows the failure cause identified and either fixed
(parse-shape failures eliminated, CalledProcessError rate ≲1/day) or alerting
in place so consecutive failures reach the desk.

## Related

`.claude/skills/alerting/SKILL.md`; flash tiering spec
`docs/superpowers/specs/2026-08-17-flash-tiering-brief.md`.
