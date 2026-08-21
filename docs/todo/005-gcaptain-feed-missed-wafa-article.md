---
id: 005
title: gcaptain RSS silently missed the campaign-defining Wafa article
status: open
opened: 2026-08-21
owner: unassigned
closed:
---

## Problem

Ingest missed gcaptain's "Houthis Escalate Red Sea Campaign, Claim Eighth
Saudi Tanker Attack" (published Wed 19 Aug — the Saree statement claiming the
*Wafa* strike and nine operations against Saudi territory) while capturing 13
other gcaptain items the same day. No fetch error was logged. The article the
maritime source was added for — a Houthi campaign-escalation claim — is
exactly the kind that never entered `items`.

## Why it matters

The 20 Aug morning brief called prediction `a64b23c1` (new Houthi attack
claim by 20 Aug, 0.8) "MISS trajectory" while the scoring event sat on
gcaptain's front page; the 21 Aug close-out caught it only because the
deepdive swept `?s=houthi` by hand. Playbook #4 (maritime claims go through
the maritime trade press) currently assumes this feed is complete; it
demonstrably isn't. A missed escalation item is a missed scan alert.

## Evidence

- Article exists and extracts cleanly:
  `https://gcaptain.com/houthis-escalate-red-sea-campaign-claim-eighth-saudi-tanker-attack/`
  (extracted 2026-08-21T01:00:58Z).
- Absent from the DB: `SELECT * FROM items WHERE url LIKE
  '%eighth-saudi-tanker%'` → 0 rows (checked 2026-08-21T01:05Z).
- Feed was healthy that day: 13 gcaptain items with `published_at` on
  2026-08-19, fetched throughout the day (02:00Z–23:15Z), including two
  Iran/Hormuz stories (10:15Z "Trump Takes Iran Hard Line…", 17:02Z "Three
  Chinese Tankers U-Turn…").
- Zero gcaptain rows in `source_errors`, any date.
- Poll-cadence gap observed: no fetch landed items between 11:16Z and 13:15Z
  on 19 Aug despite `interval_minutes: 60` (`config/sources.yaml:105`).
  Unknown: whether the article's pubDate fell in that gap and scrolled out of
  the feed window, or whether it never appeared in
  `https://gcaptain.com/feed/` at all (category-scoped feed?). Neither was
  checked — that needs a live comparison of feed contents vs the site at
  publish time, which can't be reconstructed after the fact.

## Fix

Instrument, then decide: (a) log raw item count + oldest pubDate per gcaptain
fetch to see whether the feed window scrolls past items between polls (if so,
tighten the interval for maritime sources); and/or (b) add a second gcaptain
fetch (security/incident category RSS or the `?s=` search page) and dedupe.
Source additions are Saman's call (17 Aug lessons entry approving gcaptain).

## Done when

A week of spot-checks shows no article on gcaptain's front page or
`?s=houthi` search that is absent from `items`; or abandoned with reasoning
if the miss proves a one-off feed anomaly.

## Related

Playbook #4, #16; `a64b23c1` scoring note in `state/predictions.jsonl`;
lessons-inbox 2026-08-21 entries.
