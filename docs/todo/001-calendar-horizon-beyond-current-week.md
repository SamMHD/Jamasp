---
id: 001
title: Economic calendar cannot see beyond the current week
status: open
opened: 2026-08-17
owner: unassigned
closed:
---

## Problem

`jamasp calendar` can never show an event more than ~7 days out, because the
only calendar source is ForexFactory's **current-week** JSON. At the week
boundary the horizon collapses to a day or two. There is no second source
covering the weeks after this one.

This is a property of the source, not a bug in the code — the view was fixed
in `0091e22` to state the horizon it actually has instead of claiming "next
14d". What remains open is the coverage gap itself.

## Why it matters

Event-anchored work loses its anchor past the current week:

- Playbook heuristic #8 caps a one-side-sourced deadline claim at 0.5 **unless
  it is anchored to a scheduled event**. If the calendar can't see the event,
  the anchor has to be recalled from memory or hand-copied into
  `state/watchlist.yaml`.
- Prediction windows longer than a week (there were 13 open on 2026-08-17,
  several with 29–41 day horizons) can't be framed against the FOMC or CPI
  dates that will actually resolve them.
- It already produced two weeks of wasted attention: the 9 and 16 Aug retros
  read the short horizon as a dead feed and carried "calendar feed dark
  (0 events/14d)" as a standing dev task. It was never dark.

Not urgent. The desk works around it with `state/calendar.yaml`, which is
where far-horizon events belong today.

## Evidence

Checked 2026-08-17. **The negatives are the useful part — don't re-probe
these:**

- `config/sources.yaml` has exactly one `type: calendar` entry, `ff_calendar`,
  pointing at `https://nfs.faireconomy.media/ff_calendar_thisweek.json`.
  Returned 200 with 96 events spanning `2026-08-16 .. 2026-08-21`.
- Every other faireconomy path tried returned **404**:
  `ff_calendar_nextweek.json`, `_lastweek`, `_thismonth`, `_nextmonth`,
  `_tomorrow`. Only `thisweek` exists.
- **BLS** release schedule — `https://www.bls.gov/schedule/news_release/bls.ics`
  and `.../2026_sched.htm` — **403 from the host**, including through
  `jamasp.net.get_with_fallback` (i.e. the WARP proxy that the working
  `bls_latest.rss` feed depends on). So the proxy is not the missing piece.
- **Federal Reserve** — no ICS or FOMC-dates feed at
  `federalreserve.gov/calendar.ics` or `/feeds/fomc_press.xml` (both 404). The
  real path was not found; the FOMC calendar page is HTML
  (`/monetarypolicy/fomccalendars.htm`) and would need a parser.
- **TreasuryDirect** announced auctions —
  `https://www.treasurydirect.gov/TA_WS/securities/announced?format=json&days=90`
  returned **200, ~385KB JSON**. This is the one live lead. Not wired up:
  auction dates alone are a narrow slice of a calendar, though the 30-year
  auction tail was one of the ~10 desk-relevant items in the 13 Aug sample.
- Host DB at the time: `MAX(starts_at)` on `events` was `2026-08-21T14:00:00Z`
  while `calendarview.render` was being called with `days=14`.

Unknown: whether any free source covers FOMC/CPI/NFP dates months ahead
without a key. Not exhaustively searched — FRED's release-dates API
(`/fred/releases/dates`) needs an API key, which is already on the backlog in
`docs/future-sources.md`.

## Fix

Any one of these closes it; they are listed cheapest first.

1. **Wire TreasuryDirect** as a second `type: calendar` source with a new
   parser (`treasurydirect_json`), following the shape of
   `parse_ff_json` in `jamasp/ingest/calendar.py` — id hash, UTC
   `starts_at`, an `impact` value. Gives ~90 days of auction dates only.
2. **Parse the Fed's FOMC calendar page** for meeting dates. HTML, so it needs
   an extract-and-scrape step rather than a feed, but the dates change rarely
   and matter most.
3. **Get a FRED API key** and use `/fred/releases/dates`, which would cover
   CPI/PPI/NFP release dates properly. Best coverage, needs a key and the
   backlog item in `docs/future-sources.md`.
4. **Abandon it** and make `state/calendar.yaml` the documented home for
   anything beyond the current week — a legitimate outcome, given the desk
   already does this.

Whatever lands, keep the honest-horizon header from `0091e22` truthful: it
reports `MAX(starts_at)`, so a second source with a longer reach makes it
correct automatically.

## Done when

`uv run jamasp calendar` on the host lists at least one High-impact event more
than 7 days ahead, **or** this file is closed as `abandoned` with option 4
recorded and `state/calendar.yaml`'s role documented in CLAUDE.md.

## Update 2026-08-22 — near-miss raises priority

The horizon gap nearly cost a market-moving print: core PCE was carried as
Fri 28 Aug in stance/calendar.yaml/wakeup #29, but prints **Wed 26 Aug
12:30Z** — caught only because the Saturday brief extracted two week-ahead
sources (Wells Fargo via actionforex + the actionforex calendar table).
The wakeup would have fired two days late. Third hand-built date error in
ten days (FOMC minutes 19th-vs-20th, Warsh keynote 21st-vs-28th, PCE
26th-vs-28th) — all "~date" chatter hardening into anchored wakeups with
no feed to verify against once the current week ends. Interim mitigation
now in lessons-inbox: Saturday briefs re-verify the coming week's data map
by extract; wakeup dates need a primary-calendar citation within 7 days of
firing. A real second source (options 1–3) remains the fix.

## Related

- `0091e22` — honest-horizon header, and the `docs/future-sources.md` addendum
  recording these dead ends.
- `docs/future-sources.md` — "Calendar horizon — no free replacement found
  (2026-08-17)" section, plus the pre-existing FRED-key backlog item.
- `reports/2026/08/2026-08-09-retro.md` and `...-16-retro.md` — where the
  phantom "calendar feed dark" task came from.
- Playbook heuristic #8 (scheduled-event anchor) is the rule this gap weakens.
