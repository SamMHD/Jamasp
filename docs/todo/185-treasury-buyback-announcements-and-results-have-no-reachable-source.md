---
id: 185
title: Treasury buyback announcements and results have no reachable source
status: open
opened: 2026-09-09
owner: unassigned
closed:
---

## What happened

Wakeup #41 (9 Sep 2026 15:15Z, first enlarged long-end buyback operation)
could not read the primary document. The only ingested item was an
investinglive relay ("US Treasury announces $6 billion buyback, less than
expected", 15:03Z). None of Treasury's own surfaces extract:

- `https://www.treasurydirect.gov/auctions/buybacks/` and
  `.../instit/annceresult/buybacks/buybacks.htm` — `extract` returns empty
  text (JS-rendered tables, no article body).
- `https://home.treasury.gov/news/press-releases` (and `?title=buyback`) —
  extract returns only the .gov banner boilerplate.
- `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/buybacks_operations`
  — JSON; `extract` raises "could not extract article text".

The slot itself was carried as UNVERIFIED for ten days (24 Aug → 9 Sep)
because no schedule was ever ingested; the operation results (amount
accepted vs cap, offer-to-cover, tail, CUSIPs) and even the operation date
remain unknown to Jamasp at close of the run.

## Proposed fix

Wire a deterministic source in `config/sources.yaml` against the FiscalData
buybacks datasets (`buybacks_operations`, `buybacks_security_details` —
JSON, no auth) and/or the TreasuryDirect buyback XML/API, emitting one item
per announcement and one per result with size, cap, cover and tail in the
lede. Alternatively teach `jamasp extract` to render JSON responses as text
so an agent run can read the API directly. The buyback program runs through
4 Nov 2026 with operations expected every one to two weeks, so this is a
recurring blind spot, not a one-off.
