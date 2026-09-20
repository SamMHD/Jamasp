---
id: 187
title: "`jamasp price` GC_CLOSE is the Globex running value, not the COMEX settle, and is not labelled provisional — a scan scored a prediction on it"
status: open
opened: 2026-09-20
owner: unassigned
closed:
---

## Problem

`jamasp price` prints `GC_CLOSE <value> @<date>` with no indication of
whether the Globex session behind it is still open. During the session the
value is the running last trade; after ~21:00Z it is the Globex close. It
is at no point the CME/COMEX 17:30Z settlement, which is what most press
relays ("gold settled at…") and most of the desk's level claims mean by
"settle". The three numbers routinely differ by tens of points.

## Why it matters

- **A prediction was mis-scored on it.** `f8b7b030` ("no GC settle above
  4387.3 Thu/Fri", 0.5) was scored **MISS** at the 17 Sep 19:00Z scan on a
  GC_CLOSE running value of 4402.9 (ticks 4400.9 @17:21Z, 4402.2 @17:35Z).
  By the 18 Sep 03:30Z brief the finalised GC_CLOSE row read **4382.7** —
  *below* the line — because gold gave back 20 pts between the COMEX settle
  and the 21:00Z Globex close. The score stands as a calibration-discounted
  miss; the ledger now carries one entry whose outcome depends on which
  minute the scan ran.
- **Claim texts have to carry the disambiguation by hand.** Since 18 Sep
  every GC level claim spells out "GC_CLOSE row as read the next morning —
  the COMEX settle is NOT the basis" (`d571e0f0`, `64c7ba41`, `b06eaec0`);
  playbook rule 17 (20 Sep rewrite) makes it mandatory. That is the
  analysis-side patch for a tool that could say it itself.
- **Two "closes" for one instrument is the same defect the 10y has** — the
  `542f76be` scoring note (9 Sep): `^TNX` last row 18:20Z vs the wrap's
  21:00Z cash close, 2bp apart across a 4.80 line.

## Evidence

Observed on this host:

- `jamasp price` output 17 Sep ~19:00Z (scan) — `GC_CLOSE 4402.9
  @2026-09-17`; same command 18 Sep 03:30Z — `GC_CLOSE 4382.7
  @2026-09-17`. Same date label, 20-pt difference, no flag.
- `jamasp price` 20 Sep 16:00Z: `GC_CLOSE 4424.9 @2026-09-20 (24h: +0.00%,
  7d: +0.36%)` while the last `GC` tick is `4415.9 @2026-09-18` — the
  GC_CLOSE row is stamped with the *computation* date, not the session
  date, and its "24h" delta compares two reads of the same closed session.
- Lessons-inbox 2026-09-18 (consumed by the 20 Sep retro) records the
  `f8b7b030` sequence in full; the 19 Sep brief re-scored nothing (the
  MISS was left, discounted).
- CNBC `/quotes/@GC.1` (per memory, `--fresh`) and the investinglive
  Americas wrap carry the COMEX settle; nothing in `prices` does.

## Fix

Smallest change that removes the class of error:

1. **Label the state.** `jamasp price` prints `GC_CLOSE … (provisional —
   session open)` whenever the underlying Globex session has not closed
   (Mon–Thu before ~21:00Z; Fri before ~21:00Z; Sun after 22:00Z), and
   `(final)` otherwise. Stamp the row with the *session* date, not the
   computation date.
2. **Optionally add a settle series.** A `GC_SETTLE` row from the CME
   settlement (17:30Z) if any reachable source publishes it as data;
   otherwise document in the toolbox line that GC_CLOSE ≠ settle and point
   at the CNBC/investinglive relay for the settle.
3. **Skill side.** The scan skill's scoring guidance: never score a level
   claim on a `provisional` GC_CLOSE; mark "breach trajectory" and leave it
   to the brief (playbook rule 17 already says this; the tool should make
   it hard to get wrong).

## Done when

- `jamasp price` run at 19:00Z on a weekday prints GC_CLOSE with a
  `provisional` marker and the session date; run at 03:30Z the next morning
  prints `final` with the previous session's date (test pins both with a
  synthetic `now`).
- The toolbox table in `CLAUDE.md` or the `price` help text states that
  GC_CLOSE is the Globex close, not the COMEX settlement.

## Related

- `state/playbook.md` rule 17 (20 Sep 2026) — the manual discipline.
- `docs/todo/183` — the other GC feed gap (dark on a US holiday).
- `docs/todo/003` — Yahoo chart timestamp errors on the same source.
- `reports/2026/09/2026-09-20-retro.md` — the `f8b7b030` scorecard entry.
