---
id: 193
title: "No reachable BEA/BLS primary on print days — the 'largest single component / ex-that number' mandate (playbook rule 14) depends on relays that may not carry the split, and PCE's does not"
status: open
opened: 2026-09-30
owner: unassigned
closed:
---

## Problem

Every data-event wakeup (CPI, PCE, NFP) carries the rule-14 mandate: name
the largest single component and the ex-that number before the odds
sentence. For CPI and NFP the investinglive print post carries a table
(gasoline, wireless, AHE …) and the mandate is met at print+0. For PCE it
is not: on 30 Sep 2026 (#62) the investinglive PCE post carried headline /
core / income / spending only, actionforex's live-comments post carried
the same plus real PCE and the saving rate, and neither carried the goods
/ services / energy / food split or the housing line.

The primaries all 403 through `jamasp extract`: `bea.gov` (release page,
"Personal Income and Outlays" tables, the annual-update PDF), `bls.gov`.
CNBC's article existed (index headline "Fed's preferred gauge showed core
inflation at 3.0% in August, much lighter than expected" at 13:18Z) but
CNBC's index pages extract titles without URLs and the slug is not
derivable — six guesses 404'd. MarketWatch's PCE piece extracted two
paragraphs (paywall).

## Why it matters

- The hot/soft verdict on a PCE day is written on the headline−core gap
  alone (energy/food ≈ 0.1pp on 30 Sep). Whether the 0.2 core was goods
  deflation masking services at 0.3, or housing at 0.1 with everything
  else firm, is exactly what the Fed relay argues about for the next two
  weeks — and the run cannot say.
- The BEA annual update (30 Sep) revised the 2021–25 trend; the only
  relay figures were July's y/y (3.3 → 3.0) and Q2's (3.6 → 3.3). The
  size and shape of the revision by year is unknown to the stance.
- The same gap will hit the mid-October CPI if investinglive's post is
  late or truncated: there is no fallback primary.

## Fix

1. Wire one reachable primary for BEA and BLS release tables through the
   existing proxy path in `jamasp/extract.py` — candidates: the BEA
   `apps.bea.gov/api` (free key, JSON; `NIPA` table T20806 for monthly
   PCE by category), the BLS `api.bls.gov/publicAPI/v2` (CPI series by
   item), or FRED's series for the PCE components (already used for
   DFII10/DTWEXBGS — `PCEPILFE`, `DGDSRG3M086SBEA`, `DSERRG3M086SBEA`,
   `DNRGRG3M086SBEA`), which update on release day.
2. Add a `jamasp components pce|cpi` subcommand (or a section in the
   print-day deepdive skill) that prints the top three contributors and
   the ex-that number from the primary, so rule 14 is one command.
3. Until then, the deepdive skill's PCE order should say: read the split
   from the Thu brief's CNBC/MarketWatch item once it lands in `items`
   (query by headline, ignore `read_at`), and write the print-day verdict
   on the headline−core gap explicitly labelled as such.

## Done when

- A PCE/CPI print-day run can name the largest component from a primary
  within the run (≤ print+45) without a CNBC slug guess.
- `reports/` no longer carries "component split not in either relay" on
  a PCE day.

## Related

- Playbook rule 14 (27 Sep 2026); rule 15 (date agency copy from its own
  dateline).
- Memory: BLS/BEA pages 403; CNBC quotes and article pages extract when
  the URL is known.
- `docs/todo/192` — the same "hand read of a CNBC page" shape for oil.
- #62 report section, `reports/2026/09/2026-09-30-brief.md`.

## Update 2026-10-04 (retro)

4 Oct retro: NFP's component split was available at print+0 (the investinglive print post carries the sector lines, #61 2 Oct), so the gap is PCE-specific — BEA 403s, neither relay carries goods/services/energy at print+50, and the CNBC article URL is not derivable from its index headline (six slug guesses 404 on 30 Sep). Playbook rule 14 now treats the PCE split as a next-brief item once the CNBC/MarketWatch piece lands in `items`.
