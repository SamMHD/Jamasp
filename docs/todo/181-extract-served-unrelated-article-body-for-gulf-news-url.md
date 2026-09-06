---
id: 181
title: "`jamasp extract` returned an unrelated article's body for a Gulf News URL (six-vessel IRGC story → Sanandaj tanker accident)"
status: open
opened: 2026-09-06
owner: unassigned
closed:
---

## What happened

Sunday 6 Sep brief, 03:31Z. `uv run jamasp extract` on

    https://gulfnews.com/world/mena/irgc-targets-3-oil-tankers-3-us-linked-vessels-on-unauthorised-hormuz-routes-1.500664640

(inbox item `e38b300576eb258b`, published 02:49Z) printed a fresh
`fetched_at` header (0.2h) and then four paragraphs of a *different*
Gulf News/Xinhua story — the Sanandaj–Hamedan fuel-tanker road accident
("At least 11 people were killed…"). No IRGC content at all. Two other
Gulf News URLs extracted correctly in the same minute, so this is not a
site-wide 403 or paywall.

Likely causes, unverified: Gulf News served a "live blog / related story"
page whose first `<article>` block is another item, or the URL redirected
to a hub page and the readability pass picked the largest text block. The
word "tanker" in both headlines is suggestive of a related-content widget.

## Why it matters

- The freshness header (rule 16) does not catch this trap: the page was
  fresh, the *content* was wrong. A run that trusted the text would have
  written a Sanandaj road accident into an Iran-escalation stance.
- Same failure class as the 16 Aug AJ index snapshot (rule 16) — the
  guardrail there was dateline discipline; here the guardrail has to be
  a headline/title match.

## Suggested fix

- After extraction, compare the page's `og:title` / JSON-LD `headline`
  (or the first `<h1>`) against the requested item's headline when the
  URL came from the inbox; on a low similarity score, print a loud
  `WARNING: extracted title does not match item headline` line above the
  text and do not cache the result.
- Prefer JSON-LD `articleBody` when present before falling back to the
  largest-text-block heuristic.
- Add the URL above as a regression fixture once the cause is confirmed.

## Workaround used

Read the same facts from the Gulf News wrap
(`us-iran-war-tanker-strikes-open-dangerous-new-phase…-1.500664548`),
which extracted correctly and carries the six-vessel claim.
