---
id: 207
title: "`jamasp inbox --mark-read` marks every unread row, including items ingested after the run's `inbox` listing — they are consumed without any run having seen them"
status: open
opened: 2026-11-21
owner: unassigned
closed:
---

## What happened

Scan 2026-11-21 07:00Z. `jamasp inbox` listed **12 unread** at 07:00:08Z.
The close-out `jamasp inbox --mark-read` at 07:00:30Z reported
**"marked 16 items read"**. Three of the extra four rows have
`fetched_at = 2026-11-21T07:00:27Z` — the 15-minute ingest landed between
the listing and the mark:

- gulf_news — "Middle East war: 5 things UAE residents need to know today (Nov 21, 2026)"
- gulf_news — "Passenger plane makes emergency landing in Philippines…"
- national_business — "Anthropic's post-IPO slide shows hype not enough to ease AI investor fears"

(The fourth, national_business "Oil prices post third weekly decline…",
was fetched 05:00:19Z and not shown in the listing — probably a deduped
cluster member; not verified.)

None was urgent this time; the run found them only because the count
mismatch (12 listed vs 16 marked) prompted a manual query of `items` by
`read_at`.

## Why it matters

`mark_read` (`jamasp/inbox.py:85`) is
`UPDATE items SET read_at = ? WHERE read_at IS NULL` — no upper bound. The
scan timer and the ingest timer both fire on the hour, so every scan slot
races an ingest: anything that lands during the run (seconds for a silent
scan, up to 15 minutes for a brief or deepdive) is marked read unseen. With
todo-184 (silent scans leave no trace for the brief) this is a second way a
headline can vanish before any run reads it — and on a live-market slot the
unseen item could be the wire flash the scan exists to catch.

## What should change

Bound the mark to what was listed. Options, cheapest first:

1. `inbox` prints a high-water mark (max `fetched_at` or rowid) in its
   header and `--mark-read --upto <mark>` only marks rows at or below it.
2. `inbox` records the listed high-water mark in the DB (per run) and
   `--mark-read` uses the last recorded one by default.
3. At minimum, have `--mark-read` print how many of the marked rows were
   fetched after the last listing, so the run knows to look.

Add a test: insert an item after the listing, assert it stays unread.

## Workaround used

When "marked N" exceeds the listed count, query
`select published_at, fetched_at, source, headline from items where read_at like '<mark ts>%'`
and read the rows the listing did not show before exiting.

## Recurrence log

- **Scan 2026-11-21 09:00Z — count mismatch without a race.** Listed 15
  at 09:00:06Z and again 15 at 09:00:24Z (re-list immediately before the
  mark, no new ids); mark at 09:00:25Z reported **20**. All five extras
  have `fetched_at = 08:31:29Z` — 29 minutes *before* the listing: four
  actionforex "EUR/xxx Weekly Outlook" rows and a second mehr_en copy of
  the CITEX photo item (the listed row carried it under `also`). So the
  listing hides rows on its own (cluster duplicates, and apparently
  FX-cross technical outlooks), which settles the unverified fourth row
  above and means "marked N > listed" is **not** a clean race signal —
  option 3 should report rows *fetched after the listing*, not the raw
  difference. None of the five was gold-relevant.
- **Scan 2026-11-21 11:00Z — same pattern, again no race.** Listed 16 at
  11:00:06Z; mark at 11:00:27Z reported **23**. All seven extras are
  actionforex FX-pair "Weekly Outlook/Report" rows with `fetched_at`
  09:01:31Z / 09:31:35Z — 90+ minutes before the listing, so hidden by
  the listing, not late arrivals. None gold-relevant.
- **Scan 2026-11-21 13:00Z — same pattern, cluster-duplicate kind.** Listed
  15 at 13:00:05Z; mark at 13:00:16Z reported **16**. The extra is a
  mehr_en re-headline ("…recent two wars") of a row already read at
  11:00Z, same `cluster_id`, `fetched_at` 12:45:57Z — 14 minutes before
  the listing, so hidden as a duplicate of an already-read cluster head
  (no `also` to show it under). Not a race; not gold-relevant.
- **Scan 2026-11-21 17:00Z — same pattern, first content-bearing hidden
  row.** Listed 18 at 17:00:07Z; mark at 17:00:25Z reported **20**. Both
  extras were fetched before the listing (16:16:26Z, 16:45:46Z) — not a
  race. One is a northern_miner re-headline of the Angola / De Beers row
  (same `cluster_id`, head read 03:35Z; not gold-relevant). The other is
  Gulf News "Middle East war: 8 things UAE residents need to know
  tonight, November 21" (`1113b3e6020910aa`), clustered
  (`c73a6ed9bffffbb3`) with the **20 Nov** edition "6 key updates … this
  evening, November 20" and hidden as a duplicate of that already-read
  head. That is a false cluster: a dated daily digest whose body is new
  every day. Its body carried the day's Gulf items (UKMTO: two tanker
  incidents near Khasab on Saturday; CENTCOM's denial of the F-16 claim;
  an Iranian navy mine claim). None met the scan's alert test, but this
  is the first hidden row that was gold-relevant, and the scan read it
  only because of the manual count check. For the fix: besides reporting
  hidden rows, either the clusterer should not merge serial digests
  across dates (date token in the headline differs, `published_at` ~24h
  apart), or the listing should show an unread row whose cluster head is
  already read.
- **Scan 2026-11-23 11:00Z — largest gap so far, and the first true race.**
  Listed 35 at 11:00:08Z; `--mark-read` at 11:00:17Z reported **"marked
  58 items read"**. Of the 23 extra rows, ~19 carry `published_at`
  10:23Z–10:58Z and were not in the listing at all: an ingest pass landed
  inside the nine seconds between the two commands (the scan and ingest
  timers both fire on the hour). The rest are cluster duplicates (UK /
  eurozone flash PMI siblings, the MarketWatch re-headline). Read after
  the fact from the `items` table by `read_at`; none met the alert test
  (Ackman on a Fed-hike recession, Nvidia / Huang rehiring, Saxo COT, ECB
  DLT collateral). The brief will not see them either. For the fix: this
  is the case the title describes — `--mark-read` should take the
  listing's cut-off (max `fetched_at` or an explicit `--until`) rather
  than marking everything unread at call time.

- **Recurrence — scan 2026-11-23 13:00.** Listed 27 at 13:00:06Z;
  `--mark-read` at 13:00:18Z reported **"marked 33 items read"**. The six
  extra rows are actionforex pair outlooks (EUR/USD, USD/JPY, GBP/USD,
  USD/CHF, USD/CAD, GBP/JPY; `published_at` 11:01Z–11:48Z) that were not
  in the listing. Read after the fact from `items` by `read_at`; none met
  the alert test. Same on-the-hour collision of the scan and ingest
  timers as at 11:00.

- **Recurrence — scan 2026-11-23 17:00.** Listed 24 at 17:00:07Z;
  `--mark-read` at 17:00:23Z reported **"marked 31 items read"**. Not a
  race this time (all seven extras were fetched 15:15Z–16:01Z): every one
  is an unread row hidden behind a cluster head already read at 11:00Z,
  13:00Z or 15:03Z — four Nvidia / Huang re-headlines, the investing.com
  gold and oil wraps, and the **US flash services PMI print post
  (forexlive, 54.7 vs 55.7), which was clustered under the France /
  eurozone flash PMI head read at 11:00Z**. That last one is the
  mis-cluster variant: a scan-marker print hidden from the listing by a
  different country's print. Read after the fact from `items` by
  `read_at`; none met the alert test (the 15:00Z alert already covered
  the move and the PMI).

- **Recurrence — scan 2026-11-23 19:00.** Listed 39 at 19:00:09Z;
  `--mark-read` at 19:00:56Z reported **"marked 45 items read"**. Both
  variants in one run. Four extras are the on-the-hour race (fetched
  19:00:31–32Z, after the listing: two MarketWatch items, and mining.com's
  AngloGold / Sitka and Springpole pieces). Two are cluster-hidden unread
  rows: a gcaptain Costa Concordia item and the **investing.com oil wrap
  "Oil drops more than 3% on increased Middle East flows, Libyan pipeline
  restart" (17:30Z)** — the one row in the delta that bears on a live
  stance clause (Monday's Brent settle vs 92.10), and it was not in the
  listing. All six were read from `items` *before* marking this time (a
  count check between the listing and `--mark-read`); none met the alert
  test. The Tue brief will not get the oil wrap from `inbox`; it reads the
  Brent settle directly, but the "increased Middle East flows" reason
  reaches it only if it sweeps `items` by keyword.
- **Recurrence — brief 2026-11-24.** Listed 109 at 03:30:17Z;
  `--mark-read` at ~03:35:50Z reported 130. All 21 extra rows were
  published before the listing (23 Nov 11:08Z – 24 Nov 02:25Z), so this is
  the cluster-hidden kind, not a race. Read from `items` *after* marking
  this time (the brief did not run the count check first). Three carried
  content the brief had not seen: the PBoC fix 6.7111 against a 6.6757
  estimate (forexlive 01:16Z), Mehr's "Iran dismisses reports about move to
  break US blockade" (bears on prediction `843b39e4`), and the Investing.com
  oil wrap's "increased Middle East flows" reason — the same wrap the 19:00Z
  scan flagged as one the brief would miss. Added to the report as an
  addendum, headline-only.
- **Recurrence — scan 2026-11-24 05:00.** Listed 26 at 05:00:06Z;
  `--mark-read` at 05:00:43Z reported **"marked 27 items read"**. One
  cluster-hidden row, no race row this slot (count check at 05:00:33Z,
  before marking): gulf_news "How an Abu Dhabi teacher turned childhood
  anxiety into books that help children feel seen" (published 02:00Z,
  fetched 03:46:10Z — after the brief's mark, before this listing). Benign.
- **Recurrence — scan 2026-11-24 07:00.** Listed 38 at 07:00:06Z;
  `--mark-read` at 07:00:55Z reported **"marked 50 items read"**. Ten race
  rows (fetched 07:00:41–48Z, mid-run) and two cluster-hidden rows
  (national_business "US deepens Gulf partnerships with Qatar critical
  minerals agreement"; investing_commodities "Oil prices near three-month
  lows as rising supply offsets Hormuz threat"). Count check ran before
  marking; all twelve read by headline, none met the alert test. Race rows
  the Wed brief will not get from `inbox`: gulf_news "Brent drops to $88,
  WTI at $79: Why oil is sliding despite Iran's tanker attacks" (extracted
  — flows/supply piece, no UKMTO or operator text on the IRGC three-tanker
  mine claim), mehr_en "Iran not to engage in talks till its conditions
  met: Ghalibaf", gulf_news "Israeli transport ministry approves resumption
  of flydubai flights after attack", national_business "Iraqi oil minister
  demands federal control of northern fields held by Kurdistan region",
  gold_eagle "Gold SWOT: UBS and Goldman Sachs see gold recovering by late
  2027". The mine claim itself (Mehr 04:02Z, IRGC Navy PR; investinglive
  03:58Z "not independently confirmed") bears on prediction `4cab4fd3` —
  an Iranian claim, not scoring; Brent 89.08 (−0.32%), gold 3617.3.
- **Recurrence — scan 2026-11-24 09:00.** Listed 120 (the cap) of a
  header "158 unread" at 09:00:06Z; 242 rows unread at the 09:02:39Z count
  check, before marking. Of the 122 unlisted: 94 are 2012–13
  `national_business` archive rows (38 cut by the cap, 56 landed
  09:00:16Z — todo 209), 20 race rows fetched 09:00:16–17Z (Gulf News
  local, Maritime Executive corporate, actionforex daily pair outlooks,
  national_business "Manus on Markets: Nvidia's $1 trillion man braces for
  Congress grilling" and a duplicate of the Iraqi-PM Kurdistan takeover
  order) and 8 cluster-hidden rows. All read by headline; none met the
  alert test. One cluster-hidden row the Wed brief will not get from
  `inbox` and should: gulf_news "Mid-East war: What IRGC claimed, what
  JMIC reported…" (published 07:05Z, fetched 07:30:56Z; extracted
  `--fresh`) — **JMIC's log lists "unknown projectiles" and says Iran's
  mine claims remain unverified**, so the IRGC three-tanker mine claim
  does not score `4cab4fd3`; it names hulls for the stance's owed
  "fresh attacks on shipping" reference — *Torkel* (stern, 11 nm N of
  Khasab, fire), *Arina* (engine room, 17 nm E of Khasab), a third
  unidentified 8 nm N of Khasab — within JMIC's seven tanker attacks
  16–21 Nov (incident dates per hull not given: date-check before
  counting); threat level "severe", further attacks on the Omani side
  "highly likely" within 24–48 h. Also listed and marked: The National,
  Iraqi PM orders federal takeover of Kurdistan oil exports, border
  crossings and disputed-area oilfields (escalates the 07:00Z oil-minister
  row; Kurdistan nodes are outside `72c244f9`). Gold 3622.6 at 08:50Z.
- **Recurrence — scan 2026-11-24 11:00.** Listed 32 at 11:00:07Z;
  "marked 37 items read" at 11:00:34Z. All five extras were fetched
  *before* the listing (09:31:28Z ×4, 09:46:02Z ×1) — hidden by the
  listing, not a race: four actionforex daily technical outlooks
  (EUR/USD, USD/JPY, GBP/USD, USD/CHF) and investing_commodities "Oil
  touches three-month lows as rising supply offsets Hormuz threat"
  (consistent with the stance; not read — Investing.com 403s). Read
  before marking; none urgent. Also listed and marked, for the Wed brief's
  owed hull reference: Mehr 09:35Z relays a **UKMTO time-late report — a
  bulk carrier struck on the port side by an unknown projectile while
  anchored at Dibba OPL, 23 nm NE of Khor Fakkan, UAE; fire onboard, no
  casualties** (no warning number, vessel name or incident date in the
  relay — date-check before counting toward the "further UKMTO hull hit"
  leg). Projectile class is reached: a count, no alert. Gold 3624.6 at
  11:00Z.
- **Recurrence — scan 2026-11-24 13:00.** Listed 44 at 13:00:30Z;
  "marked 52 items read" at 13:01:00Z. Six extras were fetched *before*
  the listing (11:01:02Z–12:45:55Z) — hidden by the listing, read before
  marking; two were a race (fetched 13:00:37Z / 13:00:39Z), read after.
  **The listing hid, and the race swallowed, the only kinetic rows in the
  delta — both Mehr:** (1) hidden, published 10:02Z: Iranian Army PR — two
  "violating" tankers that entered a restricted zone east of Hormuz with
  AIS off "caught fire and were left immobilized following a collision
  with a naval mine" (the text says "early on Wednesday" — today is
  Tuesday; date unverified), plus "the Strait of Hormuz will not open
  until Iran's objectives and demands are met"; (2) race, published
  12:50Z: IRGC Navy — a **fourth** tanker exploded east of Hormuz early
  Tuesday on an "unauthorized shipping route", two others turned back
  after a radio warning. Both are principal claims with no UKMTO /
  operator / flag-state text, so neither scores `4cab4fd3` and the
  laid-mine class stays a held claim (UKMTO attributes the week's hits to
  projectiles — 09:00 entry above); a count for the Wed brief, no alert.
  Other hidden rows, benign: investing_commodities "Oil touches
  three-month lows before recovering on Hormuz threat" and "Oil prices
  inch higher…" (Investing.com 403s, not read), MarketWatch BofA 2027
  bull/bear cases, Gulf News ×2 (RAK); race row MarketWatch beef prices.
  Gold 3642.5 at 12:44Z (+9 vs the stance's 3633.5).
- **Recurrence — scan 2026-11-24 15:00.** Listed 48 at 15:00:07Z;
  "marked 59 items read" at ~15:02Z. Four extras were fetched *before*
  the listing (hidden by it, enumerated from the DB before marking):
  investing_commodities "Oil rebounds from three-month lows on Hormuz
  threat" (14:37Z) and "Oil prices choppy amid improving supplies,
  Mideast disruption fears" (13:25Z) — Investing.com 403s, not read;
  fxempire "Crude Oil Price Forecast: Rising Supplies Threaten WTI and
  Brent"; an actionforex ETH Elliott-wave duplicate. The other seven were
  this scan's own `ingest` (run to look for the 15:00Z consumer-confidence
  print): Mehr ×2 (IRGC chief — "war will not be 'merely regional'",
  intent not an act; Pezeshkian tribute), gcaptain ×3 (Healy; Ukraine /
  Russian ships off Libya and in the Gulf of Finland), MarketWatch ×2.
  All 59 enumerated before marking — no unseen race row this time. None
  urgent. **The print itself was not readable by ~15:02Z** (forexlive /
  actionforex inside the ingest interval until ~15:15Z; MarketWatch
  calendar actual still blank, consensus 92.2 / prior 91.7; Trading
  Economics calendar returned boilerplate only; conference-board.org
  errored) — the relay post lands unread for the 17:00Z scan. Tape two
  minutes after the print: 2y 4.677 (+1.1bp vs 4.666), DXY 103.80
  (−0.50%), GC 3629.5 at 14:50Z (−4.9 vs the Mon row 3634.4).
- **Recurrence — scan 2026-11-24 17:00 (ALERT scan).** Listed 44 at
  17:00:06Z; the mark reported **52**. Six were listing-hidden (fetched
  15:16Z–16:46Z, enumerated from `items` before marking): MarketWatch
  401(k) millionaires; mining_weekly Transalloys; mining.com ×2 (Osisko
  Gaspé; a cyberattack on Peninsula's Wyoming uranium mine); Gulf News
  Ras Al Khaimah bus crash; fxempire "U.S. Dollar Retreats On Tariff
  Hike". Two were race rows (fetched 17:00:29Z, seen in a second listing
  before the mark): gcaptain "Used Supertankers Now Cost More Than New
  Ships…" and Mehr "Relocation of US bases will not make them secure"
  (rhetoric, not an act). None changed the alert. **Trace for the Wed
  brief (the alert itself is `notify_log` 17:0xZ):** GC 3569.6 at 16:50Z,
  day low 3563.9 at 16:21Z (−1.9% vs the brief's 3633.5; high 3642.5 at
  12:44Z — a touch above 3638, not a close); Nasdaq Composite −2.35%
  (23,524) at 12:00 ET, 2y 4.662 (−0.4bp vs 4.666; range 4.629–4.699),
  DXY 103.835 (−0.46%), Brent 90.29 (+1.03%). Consumer confidence 103.3
  vs 92.5 (prior 91.9 rev.). **Dated rates sentence:** investinglive
  "Stock markets fall as Trump pivots…" (Tue 24 Nov ~16:00Z) — "priced
  for 26 bps in December and 58 bps through March" (no 12-month level).
  Riyadh financial-district tower hit, 11 injured (Saudi civil defence
  via SPA, Gulf News) — the office-tower class, not a supply node. Both
  margin-setter legs were met intraday at 17:00Z; the closes decide.
