---
id: 192
title: "`prices` carries no Brent or WTI series — oil-level claims cannot run the rule-20 distance test (instrument ATR × √days) from the tool, and every oil settle is a hand read of CNBC quote pages"
status: open
opened: 2026-09-27
owner: unassigned
closed:
---

## Problem

`select distinct symbol from prices` (27 Sep 2026) returns 30 symbols:
GC and its technicals, BTC, DFII10, DTWEXBGS, DX-Y.NYB, SGE_AU_CNY_G,
USDJPY, XAU_AM/PM, ^GSPC, ^GVZ, ^TNX. **No oil.** Brent and WTI levels
reach every run by hand — `jamasp extract --fresh` on CNBC `/quotes/@LCO.1`
and `/quotes/@CL.1` — and no ATR, no settle history, no forward-return
column exists for either.

Meanwhile the September 2026 regime chain is oil → 2y → DXY → gold
(playbook rule 22), the stance's flip conditions are written on Brent
settles (±2%, ±3%, ≥110), and the prediction ledger carries oil-level
claims (`b3adcf1e`, `65cd057e`, `f7a0c23d`, `a270f3f1`, `9e1829f8`).

## Why it matters

- **`f7a0c23d` (24 Sep MISS)** — "no Brent settle ≥103 Wed–Fri" was written
  at 0.55 with 4.3% of room over three sessions. Brent had printed ≥4%
  single-session moves repeatedly since 30 Aug, so the line sat inside one
  expected range. Playbook rule 20 (rewritten 27 Sep) now demands the
  distance test on the instrument's own ATR — and the tool cannot compute
  Brent's ATR, so the rule is applied from memory or not at all.
- The weights pipeline (`bars`, `signals`, the technical fit) is GC-only by
  design; that is fine. But the *fundamental* chain's first link has no
  row anywhere, so a non-transmission claim ("on the first oil-UP settle…")
  is scored by reading a CNBC page next morning and typing the number into
  the note. The 22 Sep and 26 Sep briefs both lost a line to "Brent settle
  per relay, CNBC prev close disagrees by 0.3".
- `jamasp price` deltas (24h/7d) are the brief's first paragraph for every
  other driver; oil, the driver, is absent from it.

## Fix

1. Add `BRENT` and `WTI` (front-month) to the price ingest with the same
   cadence as `DX-Y.NYB`/`^TNX` — Yahoo `BZ=F` / `CL=F` if the existing
   Yahoo path serves them (check the `730d` hourly-pull failure in
   todo-012 first), else a CNBC-quote scrape at the settle hour. A daily
   close row (`BRENT_CLOSE`, like `GC_CLOSE`) is enough; intraday is a
   bonus.
2. Compute `BRENT_ATR14` alongside `GC_ATR14` so rule 20's distance test
   is one line in the brief.
3. Label the basis (Yahoo close vs ICE settle) in the row or the symbol
   name — rule 17 needs one named basis, and the ICE settle is not the
   Yahoo 20:00Z print.

## Done when

- `uv run jamasp price` prints `BRENT` and `BRENT_ATR14` (and WTI) with
  24h/7d deltas.
- A brief can write "Brent line X is N× the three-session expected range"
  from the tool.
- `reports/` no longer carries "CNBC @LCO.1 prev close read the next
  morning" as the basis for oil claims.

## Related

- `state/playbook.md` rules 5, 17, 20, 22 (27 Sep 2026).
- `docs/todo/012` — the Yahoo hourly pull failure mode to avoid.
- `docs/todo/187` — GC_CLOSE is the Globex running value, not the settle;
  the same labelling question applies here.
- Memory note: CNBC `@LCO.1` / `@CL.1` with `--fresh` give live oil levels.
