---
id: 008
title: Wire the two Saman-approved sources — an Iranian-press feed and a maritime incident feed
status: open
opened: 2026-08-23
owner: unassigned
closed:
---

## Problem

On 17 Aug Saman approved three source additions: gcaptain (already wired;
reliability tracked as todo-005), **an Iranian-press feed**, and **an
incident feed** to serve playbook #9 (no-incident claims require a live
incident feed). The latter two are not wired, and the approval sits only in
a consumed lessons-inbox entry and retro prose — exactly the re-raise
pattern this directory exists to stop.

## Why it matters

- Playbook #9 currently forces every no-incident claim to be scoped down to
  "operator/press-confirmed events" because UKMTO is unreachable from the
  host; `aba1ae09` (7 Aug) missed on exactly this gap.
- Iranian statements are load-bearing for the kinetic tail (Saree campaign
  claims, IRGC doctrine statements) and currently arrive mainly via Mehr
  plus second-hand relays; a second Iranian source would cover Mehr's gaps
  and enable the two-outlet dateline cross-check that playbook #16 uses.

## Evidence

Per-feed status from this host (memory note "Jamasp delivery blockers",
accumulated through 23 Aug — extract-level checks, not RSS-level):

- Works: Mehr (`mehr_en` already ingesting — e.g. the 19 Aug Saree item),
  gcaptain (wired).
- **403 on extract from this host:** Press TV, Tasnim, IRNA, ukmto.org,
  centcom.mil. These are the negatives — don't re-probe blindly; RSS
  endpoints may still differ from article extraction and were NOT
  separately verified.
- Unknown: whether Press TV/Tasnim/IRNA expose fetchable RSS despite
  article-page 403s; whether a JMIC or gcaptain incident-category feed can
  stand in for UKMTO (todo-005's fix (b) overlaps here).
- Saman's condition (17 Aug lessons entry): per-feed fetch/extract
  verification from the host **before** wiring, as in the 31 Jul source
  research.

## Fix

1. From the host, probe candidate feed URLs (RSS/Atom) for: Tasnim EN,
   IRNA EN, Press TV, and for incidents: JMIC advisories, gcaptain
   incident/security category. Record HTTP status + sample item per
   candidate.
2. Wire the best one of each class into `config/sources.yaml` with an
   appropriate `interval_minutes`.
3. Then narrow playbook #4's manual half and #9's scoping at the next
   retro (both heuristics already carry pointers here).

## Done when

One Iranian-press feed and one incident feed are ingesting into `items`
with a week of error-free fetches, and playbook #9's "UKMTO dark"
workaround wording has been revisited; or abandoned per-feed with the
probe results on record.

## Related

todo-005 (gcaptain reliability; fix (b) overlaps); playbook #4, #9, #16;
lessons-inbox 2026-08-17 (consumed by the 2026-08-23 retro); memory note
"Jamasp delivery blockers".
