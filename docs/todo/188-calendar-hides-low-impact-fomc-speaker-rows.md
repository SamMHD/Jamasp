---
id: 188
title: "`jamasp calendar` hides every non-chair FOMC speaker — ForexFactory tags them Low and the CLI filters to High/Medium, so the stance carried 'no Fed-speaker schedule in any feed' for two weeks while the feed had them"
status: open
opened: 2026-09-20
owner: unassigned
closed:
---

## Problem

`jamasp calendar` prints high/medium-impact events only. The `ff_calendar`
source (`config/sources.yaml:351`) tags every FOMC member speech other
than the chair's as **Low**, so the rows exist in `events` and never reach
any run. The stance (19–20 Sep) and the `fed-rate-path` watchlist entry
both stated "no Fed-speaker schedule in any feed (rule-19 risk)"; the 20
Sep retro's own calendar check repeated it ("No Fed speaker in the feed for
the next 14 days while four other central banks' speakers are listed")
before querying the table.

## Why it matters

- **Playbook rule 19 cannot be applied from the tool.** A Fed-pricing
  threshold or USD/yield level claim spanning a governor/chair appearance
  caps at 0.55/0.5; the rule needs the speaker list at claim-creation time.
  Three misses in Aug (`98bbfd33` `021357a6` `16085af9`) and `09cb81a7`
  (17 Sep) were "no catalyst in window" premises broken by tone. The
  speakers were in the feed each time, tagged Low.
- **This week specifically:** `aec5cc8b` (30y not ≥5.40 through Tue 22
  Sep) and `1889819a` (rates desk keeps the wheel, to 22 Sep) span
  Goolsbee Mon 21 Sep 10:30Z; `be4d6b22` (USDJPY <160 through Thu 24 Sep)
  spans Williams 08:10Z, Hammack 12:50Z and Paulson 14:10Z on Thu 24 Sep —
  two of them 2026 voters. None was listed as a breaker.
- **Rule 13 phantom, third family.** Calendar "outage" (Aug–Sep), "`bars`
  empty" (Sep), and now "no Fed speakers" — each a status claim carried
  from narrative memory that one query would have killed.

## Evidence

Checked on the host 2026-09-20 16:05Z:

- `events` table: 872 rows; `title LIKE '%Speaks%' AND country='USD'`:
  **33 Low, 9 Medium, 1 High** (the High is "Fed Chairman Warsh Speaks",
  28 Aug). Low rows include Musalem 20 Aug, Schmid 5 Aug, Goolsbee 13 Aug /
  3 Sep / **21 Sep 10:30Z**, Barkin 13 Aug, Daly 6 Aug, **Williams 24 Sep
  08:10Z, Hammack 24 Sep 12:50Z, Paulson 24 Sep 14:10Z** (fetched 20 Sep
  05:16Z — in the feed before the Sunday brief ran).
- `jamasp calendar` same minute: 21 events, none of the above; Lagarde,
  Macklem, Bullock, Bailey listed (Medium/High).
- Impact distribution across the table: High 104, Medium 102, Low 656,
  Holiday 10.
- `jamasp extract https://www.federalreserve.gov/newsevents/calendar.htm`
  returns only the .gov boilerplate (JS-rendered) — the Fed's own page is
  not a substitute.
- `state/stance.md` 20 Sep 03:45Z: "re-checks Fed speakers (none in any
  feed — rule-19 risk)" and "no Fed-speaker schedule in any feed";
  `state/watchlist.yaml` `fed-rate-path`: "No Fed-speaker schedule in any
  feed (rule-19 risk)". Both corrected by the 20 Sep retro.

## Fix

Smallest change that removes the class of error — pick one:

1. **Promote at ingest.** In the `ff_json` parser (or a per-source
   `impact_overrides:` in `config/sources.yaml`), map titles matching
   `^FOMC Member .* Speaks$|^Fed (Chair|Governor|Vice Chair) .* Speaks$`
   to `Medium` for `country: USD`. The rows then flow through
   `jamasp calendar`, the brief's calendar section and the panel unchanged.
2. **Or expose them on demand.** Add `--include-low` (or `--speakers`) to
   `jamasp calendar`, and have the brief skill call it once for the
   "Watching" section.

Option 1 is the smaller diff and needs no skill change; it also fixes the
panel. Either way, the retro/brief skills' rule-19 line should say where
the list comes from.

## Done when

- `jamasp calendar` on a week containing an "FOMC Member X Speaks" row
  prints it (test with a fixture row tagged Low).
- The brief's calendar/Watching section lists Fed speakers beside data for
  the coming week.
- `grep -c 'Fed-speaker schedule in any feed' state/stance.md` is 0 on the
  next brief after the fix.

## Related

- `state/playbook.md` rule 19 (6 Sep, revised 20 Sep 2026).
- `docs/todo/001` — calendar horizon; same source, different gap.
- `reports/2026/09/2026-09-20-retro.md` — Verified-this-run.
