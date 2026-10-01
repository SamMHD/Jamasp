---
id: 195
title: "`jamasp extract` drops the per-entry dates from the Board 2026-speeches index, so an undated speaker entry can only be dated by probing speech-text URLs"
status: open
opened: 2026-10-01
owner: unassigned
closed:
---

## Problem

`uv run jamasp extract --fresh https://www.federalreserve.gov/newsevents/speech/2026-speeches.htm`
returns, per entry, the title, the speaker and the "At <venue>" line — but not
the date the Board page shows above each entry. Rule 24 books Fed-speaker
slots on venue and title from this index; without the date a run has to infer
it from the entry's neighbours or from the events feed's name-only rows.

## Why it matters

- The 29 Sep brief booked #63 (Tue 19:00Z conditional deepdive) and #66
  (Thu 1 Oct 14:45Z deepdive) on Waller's "Reuters NEXT Newsmaker Interview"
  entry, read as upcoming because it was undated. The text at
  `waller20260903a.htm` is dated **3 September** — delivered four weeks
  earlier, and already in `items` as the "Fed's Waller" relay the stance
  called "no Waller relay since 3 Sep". Two agent-run slots, two attempts,
  and a stance that carried "Waller owns the governor-pause breaker
  Thursday" for two days.
- The 1 Oct brief dated the entry by its neighbours ("≤22 Sep") — right in
  direction, but a date column would have closed the question in one
  extract instead of a lesson plus a probe.

## Evidence

- 2026-10-01 14:45:41Z, `extract --fresh` of the index: every entry prints
  as "<title> / <speaker> / At <venue>"; no date line anywhere in the
  output. The live page shows a date heading per entry.
- Dated by URL probe the same sitting (14:46–14:48Z): `waller20260903a.htm`
  → "September 03, 2026 … Reuters NEXT Newsmaker Interview";
  `waller20261001a.htm` → "October 01, 2026 … FRED Con 2026";
  `barr20260929a.htm` → "September 29, 2026 … Detroit Economic Club";
  `cook20260930a.htm` → "September 30, 2026 … Asheville". 404:
  `barr20261001a`, `cook20261001a`, `barr20260930a`, `bowman20260930a`,
  `barr20261002a`; and `waller20260929a` on 29 Sep (19:45Z and 23:31Z).
- Speech-text pages keep their date as the first extracted line, so the loss
  is specific to the index page's markup, not to federalreserve.gov as a
  host.
- Negatives already known: the Board calendar page extracts only its header
  (28 Sep brief / watchlist); events-feed rows ("FOMC Member X Speaks") carry
  name and time only and are Low-tagged (todo-188) — the one Medium-tagged
  Waller row (1 Oct 14:00Z) was a FRED/AI data speech with no policy content.

## Fix

Either (a) a federalreserve.gov special case in `jamasp/extract.py` that
keeps the per-entry date element on `/newsevents/speech/<year>-speeches.htm`
(and the matching press-release index) and emits
"<date> — <title> — <speaker> — <venue>" per entry; or (b) a small
deterministic `jamasp fedspeeches` helper that parses the index HTML into
dated rows (no model) and that the brief's rule-24 step calls instead of the
raw extract. Until then the workaround is the URL probe:
`extract --fresh https://www.federalreserve.gov/newsevents/speech/<lastname><yyyymmdd>a.htm`
for the candidate date — the speaker's last relay date in `items` first.

## Done when

`uv run jamasp extract --fresh https://www.federalreserve.gov/newsevents/speech/2026-speeches.htm`
(or the helper) prints a date for every entry, verified against at least two
speech-text pages' own datelines; the `brief` and `deepdive` skills' rule-24
step points at it. Abandon with a reason if the fetched HTML turns out to
carry no per-entry date element (check the raw `_proxy_fetch` output first —
the proxy may be stripping it).

## Related

- Playbook rule 24 (venue + title; text at `/speech/<lastname><yyyymmdd>a.htm`).
- `state/lessons-inbox.md` 2026-10-01 (brief) and 2026-10-01 (#66).
- todo-188 (calendar hides Low-tagged FOMC speaker rows).
- `reports/2026/09/2026-09-29-brief.md` (#63 booking);
  `reports/2026/10/2026-10-01-brief.md` (#66 deep dive).
