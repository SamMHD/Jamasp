# Future sources — research doc

Researched 2026-07-31. **Updated same day after a per-source verification
pass run FROM the Hetzner host** (every candidate tested through the
production fetch path) plus three research sweeps on technical sources —
see the addendum at the bottom. Everything marked ✅ HERE→"added" is now
wired into `config/sources.yaml`; the tables below carry the corrected
from-Hetzner verdicts.

## Infrastructure constraints (read before adding anything)

Jamasp's ingestion is deterministic Python (`feedparser` + `httpx`) on a
Hetzner VPS. That shapes what's actually addable:

- **Cloudflare WARP SOCKS proxy** fixes IP-reputation blocks (401/403 from
  datacenter IPs — this is what unblocked CNBC/MarketWatch/Mining.com) but
  **cannot** solve active bot challenges. Confirmed unfixable client-side:
  Cloudflare challenge pages (Investing.com, FXStreet, Kitco — all return a
  challenge on every path, including `/`) and DataDome (Reuters). If a
  candidate below sits behind either, don't bother routing it through WARP.
- **RSS/Atom or a free JSON API strongly preferred.** No headless browser,
  no JS execution, no CAPTCHA solving in the pipeline.
- **Paid feeds are viable later** — the desk will pay for what's worth it.
  Rough pricing is included where public, but most enterprise data vendors
  don't publish numbers; those are marked "contact for quote."
- **Google News wrapper URLs are useless for extraction** — this problem
  will recur with any aggregator (e.g. Feedly, Newsdata.io) that rewrites
  outbound links; treat that as a disqualifying trait, not a one-off.
- A "200 OK" is not proof of a usable feed — see Khaleej Times below, which
  returns 200 on the RSS path but serves an HTML consent-wall page, not XML.
  Every candidate here was checked for actual feed content, not just status
  code, where a check was possible from this environment. A few hosts
  (BullionVault, CME Group, Zawya, The National) timed out from this dev
  sandbox specifically — not clearly bot-blocked, more likely a network path
  quirk here — and should be re-checked from the Hetzner host before ruling
  in or out.

Legend: ✅ verified working · ⚠️ inconclusive (needs re-check from deploy
host) · ❌ confirmed blocked/broken.

---

## 1. Gold/precious-metals specialist media

| Name | Feed/API | Cost | Value | Feasibility |
|---|---|---|---|---|
| Kitco | no working RSS — `/rss/`, `/news/*/rss`, `/rss/KitcoNews.xml` all previously 403; re-check today returned 404 | free (if it worked) | High — the trade-press benchmark for gold-specific commentary | ❌ Already removed from `sources.yaml` (2026-07-31). Same site-wide bot posture as Investing.com/FXStreet — assume unfixable |
| World Gold Council (gold.org) | `https://www.gold.org/rss.xml` | free | High — official demand-trends data, central-bank buying commentary, ETF-flow analysis, written for exactly this audience | ✅ **Added.** Verified from Hetzner: valid RSS, works direct, and `jamasp extract` returns clean article prose (3.3k chars on test). Caveat: feed mixes in old archive items (a 2018 entry appeared) — dedupe absorbs them |
| LBMA gold price benchmark (AM/PM auction) | `https://prices.lbma.org.uk/json/gold_am.json` and `.../gold_pm.json` | free | High — this *is* the global benchmark spot price (vs. our current GC=F futures proxy) | ✅ **Added** (as `XAU_AM`/`XAU_PM`). Verified from Hetzner: works direct, ~900KB full-history JSON each, latest auction present. Caveat: ICE Benchmark Administration (IBA) licenses real-time/historical redistribution of the LBMA benchmark for commercial use — fine for internal desk reference, worth a light legal check before publishing derived numbers externally |
| LBMA news/press | no discoverable RSS (`/rss`, `/news-insights` → 404) | — | Medium | ❌ No feed found; would need scraping, not recommended |
| BullionVault (gold-news blog) | `https://www.bullionvault.com/gold-news/rss` | free | Medium — independent retail-flow-adjacent commentary | ❌ Re-checked from Hetzner: site reachable but `/gold-news/rss` and `/gold-news/feed` both 404, and the landing page advertises no feed anywhere. No RSS exists |
| Metals Focus | no free feed; research reports/subscriptions (Gold Focus, Precious Metals Investment Focus, Gold Mine Cost Service) | paid, price not published — contact for quote | High-quality supply/demand and mine-cost data, but built for scheduled reports not a live feed | Not RSS/API-shaped — a "buy the annual report and read it manually" source, not an ingest candidate |

## 2. Macro/central-bank primary sources (beyond Fed/Treasury)

| Name | Feed/API | Cost | Value | Feasibility |
|---|---|---|---|---|
| ECB press releases | `https://www.ecb.europa.eu/rss/press.html` | free | High — euro-area rate decisions move DXY and thus gold | ✅ **Added.** Verified from Hetzner: works direct, 15 live entries |
| Bank of England | `https://www.bankofengland.co.uk/rss/news` (index at `/rss`) | free | Medium-high — GBP/gilt moves, less direct gold impact than Fed/ECB | ✅ **Added.** The dev-sandbox 403 did NOT reproduce from Hetzner — works direct there, 50 entries incl. rate decisions. A reminder that bot-wall verdicts are vantage-point-specific |
| IMF | `https://www.imf.org/en/news/rss`, `https://www.imf.org/en/rss-list/feed?category=WHATSNEW` | free | Medium — reserve-asset commentary, occasional gold-reserve mentions in Article IV reports | ❌ Confirmed from Hetzner: 403 direct AND via WARP — hard bot-wall from every vantage tried |
| BIS press releases | `https://www.bis.org/doclist/all_pressrels.rss` | free | Medium — central-bank-of-central-banks commentary, useful for systemic-risk framing | ✅ **Added.** Verified from Hetzner: works direct (the sandbox curl timeout was environment-specific), 25 entries |
| BoJ | not checked — no obvious English RSS found in this pass | free (if exists) | Medium — yen carry-trade unwinds are a live gold theme | Needs a follow-up search; skip for now |
| PBoC / SAFE gold reserves | no RSS/API — monthly "Official Reserve Assets" release on the SAFE website, gold reported in USD only (needs conversion to oz/tonnes using month-end price) | free but not machine-readable | High — China's 20-month buying streak is one of the desk's active themes | Not feasible as an automated feed; the WGC's China commentary (see §1) and secondary reporting (Kitco/Reuters-style writeups, when reachable) are the practical proxy |
| IMF IFS central-bank gold reserves by country | `gold.org/goldhub/data/gold-reserves-by-country` (WGC repackages IMF IFS data) | free, dashboard-only, no documented public API | High context, low ingest-value | Goldhub is a login-gated dashboard, not a feed — manual reference, not a source-config candidate |

## 3. Positioning/flows data

| Name | Feed/API | Cost | Value | Feasibility |
|---|---|---|---|---|
| CFTC Commitments of Traders (Socrata API) | `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?market_and_exchange_names=GOLD%20-%20COMMODITY%20EXCHANGE%20INC.&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=1` | free, no key required | High — weekly speculative positioning is a core gold-desk signal | ✅ **Added** (as `GC_NET_SPEC` = non-commercial long − short). Verified from Hetzner: works direct. Gotcha found: `commodity_name=GOLD` alone matches MICRO GOLD first — pin the main contract via `market_and_exchange_names` (the URL here does) and the parser refuses other contracts as a second guard |
| SPDR GLD daily holdings | `https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_archive_EN.csv` | free | High — GLD tonnage changes are a widely watched institutional-flow proxy | ❌ Endpoint moved since the morning check: from Hetzner it 302s to `api.spdrgoldshares.com/api/v1/barlist?underlying=gld` which serves a **PDF**, not CSV (same via proxy — not an IP block). Needs a replacement endpoint before it can be wired |
| iShares SLV holdings | `https://www.ishares.com/us/products/239855/ishares-silver-trust-fund/1467271812596.ajax?fileType=csv&fileName=SLV_holdings&dataType=fund` | free | Medium — silver is a secondary desk interest, correlated but distinct flow signal | ❌ From Hetzner: 200 with `text/csv` header but an **HTML product page** as body, direct and via proxy — interstitial served regardless of IP. Dead as given |
| COMEX warehouse stocks (CME Metals Stocks report) | `https://www.cmegroup.com/delivery_reports/Metals_Stocks.xls` | free | Medium-high — registered/eligible gold inventory levels matter around delivery months | ❌ From Hetzner: 403 with an explicit CME anti-scraping message, direct AND via WARP. Unfetchable via plain HTTP; a licensed feed is the only path |

## 4. Economic calendars

| Name | Feed/API | Cost | Feasibility |
|---|---|---|---|
| ForexFactory calendar | `ffcal_week_this.xml` and similar | free (if reachable) | ❌ 403 — confirmed scraping-hostile, matches its reputation |
| FXStreet economic calendar | `/economic-calendar/rss` | free (if reachable) | ❌ 403 — same Cloudflare posture as the already-blocked FXStreet news site |
| BLS (Bureau of Labor Statistics) release feed | `https://www.bls.gov/feed/bls_latest.rss` | free | ✅ **Added.** From Hetzner: 403 direct but works through the WARP proxy fallback (`JAMASP_EXTRACT_PROXY` in `~/.config/jamasp/env` is load-bearing for this source). Low-volume "latest numbers" summary feed — sparse but exactly the CPI/NFP prints the desk times itself around |
| BEA (Bureau of Economic Analysis) | no working RSS found at guessed path | free (if exists) | ❌ 404 on `bea.gov/rss.xml` — needs a better URL, not pursued further this pass |
| FRED release-dates API | `https://api.stlouisfed.org/fred/releases?api_key=...&file_type=json` | free, requires a (free) API key | ✅ Endpoint is live (confirmed via a clear "bad key format" error rather than a network failure) — gives scheduled release dates for CPI, NFP, PCE, etc. Would need `jamasp` to register its own FRED key (already presumably has one for DTWEXBGS/DFII10) |
| TradingEconomics calendar | see §6 | paid | API-only; calendar is bundled into the general TE subscription, not a separate free feed |

Net: the free, RSS-native economic-calendar space is thin. The FRED
release-dates API is the one clean win — it won't give forecast/consensus
numbers, only *when* releases land, but that's enough to time-box desk
attention around NFP/CPI days.

## 5. Regional/Dubai-relevant

| Name | Feed/API | Cost | Value | Feasibility |
|---|---|---|---|---|
| DMCC (owns DGCX) | no discoverable RSS — press releases live at `dmcc.ae/media-room/press-releases`, no feed link found | free (if it existed) | Medium — DMCC/DGCX product and trading-volume announcements | ❌ No feed; would require scraping the press-release listing page. Not recommended given the no-scraping posture |
| DGCX (Dubai Gold & Commodities Exchange) | no discoverable RSS; news lives at `dgcx.ae/news/<year>` | free (if it existed) | Medium-high — direct visibility into the desk's own regional exchange (contract specs, trading-halt notices, volume records) | ❌ 403 on the domain root in this test, and no feed found via search. Best bet if this matters enough: ask DGCX's exchange-relations contact directly whether a machine feed exists — exchanges sometimes have one that isn't publicly linked |
| Gulf News | `https://gulfnews.com/feed` (redirects to `/stories.rss`) | free | Medium — regional business/markets context, UAE-specific angle the international wires don't cover | ✅ **Added.** Verified from Hetzner: works direct, 11 live entries |
| Zawya (Refinitiv-owned MENA business news) | none | free (if reachable) | High — MENA business-desk-grade coverage would be a strong regional complement | ❌ Exhaustively re-checked from Hetzner: eight guessed paths 404, generic paths redirect to homepage HTML, and neither the homepage nor `/en/markets` carries any feed-autodiscovery tag. No feed exists |
| The National (UAE) | `https://www.thenationalnews.com/arc/outboundfeeds/rss/category/business/?outputType=xml` | free | Medium — UAE/Gulf business angle | ✅ **Added** (business section, 31 entries). Cracked from Hetzner: it's an Arc Publishing site and the `?outputType=xml` suffix is mandatory (bare paths 404). Economy-only variant `.../category/business/economy/?outputType=xml` (11 entries) and all-news `.../rss/?outputType=xml` (100) also work |
| Khaleej Times | `/rss/business` | free (nominally) | Medium | ❌ Confirmed from Hetzner too: HTTP 200 but a Securiti.ai consent-wall HTML page, identical from the datacenter IP. Definitively dead — a reminder that status code alone isn't sufficient proof of a working feed |

## 6. Paid wire/API tier for later

| Name | What it is | Rough pricing | Notes |
|---|---|---|---|
| LSEG Workspace (formerly Refinitiv Eikon) | Full market-data terminal + news wire (Reuters) | ~$1,500–3,000/user/month; commonly cited ~$22,000/user/year list, stripped-down tier from ~$3,600/user/year | No published list price; quote-based. Would also solve the Reuters DataDome-block problem entirely (licensed feed, not scraped) |
| Bloomberg Terminal | Full market-data terminal + Bloomberg News wire | ~$2,000–2,665/user/month (~$27,300–$31,980/year per seat); multi-year contracts standard; volume discounts to ~$20–22k/seat/year at scale | Same logic as LSEG — buys a licensed wire, sidesteps scraping entirely |
| Dow Jones Newswires (WSJ Pro / Factiva) | Wire + archive access, API or terminal delivery | Standard web access ~$3,000–8,000/user/year; full enterprise deployments (Newswires + Factiva + Risk & Compliance) $150k–$1M+/year | Wide range — worth a direct quote conversation once the desk decides it wants a real wire, not just a ballpark number |
| TradingEconomics API | Macro indicators, calendar, forecasts, 196 countries | No published tier pricing — "adjusted to your usage/features," self-serve signup, contact for quote | Would cleanly replace the calendar gap in §4 and add cross-country macro series beyond DXY/real yields |
| MetalsAPI (metals-api.com) | Gold/silver/FX JSON API, LBMA symbols included | Free tier exists (limited); paid from $19.99/mo (2,500 calls) or $39.99/mo (5,000 calls), overage ~$0.0324/call | Confirmed live (401 without a key = endpoint real, just needs auth). Redundant with the free LBMA JSON feed (§1) for spot gold specifically — more useful if the desk wants FX cross-rates or other metals in one call |
| GoldAPI.io | Gold/silver spot JSON API | Free tier: 500 requests/month, no card required; paid tiers exist but pricing wasn't fully surfaced in this pass | Same redundancy note as MetalsAPI — LBMA's own JSON feed is free and authoritative; this is a convenience layer, not a new signal |

## 7. Alternative angles

| Name | Feed/API | Cost | Value | Feasibility |
|---|---|---|---|---|
| Mining Weekly | `https://www.miningweekly.com/page/home/feed` | free | Medium — African/global mining-sector coverage, complements Mining.com | ✅ **Added.** Verified from Hetzner: works direct, 8 entries |
| Northern Miner | `https://www.northernminer.com/feed/` | free | Medium — Canadian mining-sector trade press, junior-miner-heavy | ✅ **Added.** Verified from Hetzner: works direct, 20 entries |
| Junior Mining Network | `/rss.html` | free (if reachable) | Medium — junior-miner news flow, more speculative/volatile signal | ❌ Confirmed from Hetzner: 403 direct and via WARP — bot-protected |
| Mining Journal | `/rss` | free (if reachable) | Medium | ❌ From Hetzner: `/rss` redirects to the homepage HTML — no real feed behind the path |
| ETF/fund-flow trackers (etf.com, VettaFi, WGC's own Gold ETF flows page) | no free machine feed found this pass | mostly free to read, no API without a data-vendor contract | High conceptually (institutional flow is a top-tier signal) | Best free proxy remains the SPDR GLD CSV (§3) — a dedicated cross-fund tracker would need a paid data vendor (e.g. via TradingEconomics or a specialist ETF-flow API) |
| X/Twitter signal (trader chatter, Fed-watcher accounts, geopolitical break-news) | X API v2 | Basic tier ($200/mo) closed to new signups as of Feb 2026; current model is pay-per-use: $0.015/post created, $0.005/post read (capped 2M reads/mo), or Enterprise for bulk | High signal speed for breaking macro/geopolitical news, but noisy and adversarial to filter | Feasible cost-wise at low volume (a narrow filtered stream of ~10-20 accounts would stay in the low tens of dollars/month), but this is a different ingestion shape than RSS — would need a dedicated poller, dedup logic, and real editorial judgment about which accounts are worth the noise. Treat as a v2 project, not a drop-in source |
| Reuters (business RSS) | `arc/outboundfeeds/rss/category/business/` | free (if reachable) | High — but already established as DataDome-blocked, confirmed again this pass (404/blocked) | ❌ Not fixable client-side. Only real path in is a paid LSEG/Reuters license (§6) |

---

## Implemented 2026-07-31

Wired into `config/sources.yaml` after per-source verification from the
Hetzner host (see corrected verdicts in the tables above and the addendum
below): **WGC, ECB, BoE, BIS, BLS, Mining Weekly, Northern Miner, Gulf
News, The National (business)** as news RSS; **LBMA AM/PM** (`XAU_AM`/
`XAU_PM`), **CFTC COT net spec** (`GC_NET_SPEC`), **SGE daily benchmark**
(`SGE_AU_CNY_G`) as new price parsers; **^GVZ, ^TNX, JPY=X, BTC-USD,
^GSPC, DX-Y.NYB** as config-only additions on the existing Yahoo parser;
**Saxo, ActionForex, FXEmpire forecasts, Forexlive, gold-eagle** as the
TA-commentary tier. The ingest loop now honors `interval_minutes` (skips
sources fetched within their interval; failures don't advance the clock).

---

## Addendum 2026-07-31 — technical-source research (three sweeps)

Condensed from three research passes (quant/technical data, TA commentary
RSS, physical-market microstructure). Everything recommended-and-verified
is already implemented (see above); this records what remains and what's
dead so nobody re-chases it.

### Worth doing next (needs a small amount of work)

| Candidate | What's needed | Value |
|---|---|---|
| Gold futures term structure (Yahoo `GC<M><YY>.CMX` per-month contracts, verified live) | a derived-series fetcher: two chart calls + spread arithmetic; contract symbols roll, so config must be generated, not static | contango/backwardation is a physical-stress signal a Dubai desk uniquely cares about; backwardation = squeeze |
| GLD options put/call OI ratio (Yahoo `v7/finance/options/GLD`) | one-time cookie+crumb handshake parser (`fc.yahoo.com` → `getcrumb`) | only free machine-readable options-positioning proxy that isn't bot-walled |
| VXSLV silver vol (CBOE CDN `cdn.cboe.com/api/global/us_indices/daily_prices/VXSLV_History.csv`) | CSV is OHLC-shaped — small parser or column-select; NB Yahoo's `^VXSLV` is stale/empty, use CBOE | tells whether a vol move is metals-wide or gold-specific |
| FRED release-dates API | register a free FRED API key (none on the VM; checked) | release-calendar timing for CPI/NFP/PCE beyond the ForexFactory mirror |
| Swiss customs gold trade (BAZG i14y API, verified: anonymous access, `TN8_VK_IMP` zip, HS 7108) | heavier monthly parser: unzip, filter tariff 7108, aggregate by destination country | the premier physical-flow signal — Swiss re-exports to India/China/UAE track where bullion physically goes |
| IBJA India gold rate (`ibjarates.com/API/GoldRates/`, endpoint live, token-gated, 40 hits/day cap) | signup for access token; confirm free-tier pricing | India premium/discount — #2 physical demand center, no substitute |
| US Mint bullion sales (`usmint.gov/data`, advertises CSV) | 403 from dev sandbox (Akamai, likely IP-reputation) — re-check from Hetzner via WARP before writing off | Western retail coin demand, classic sentiment tell |
| Derived in-house series (no external source): implied lease rate (SOFR − GC curve forward), Dubai retail premium (LBMA × AED 3.6725 vs DGJG print), gold/silver ratio (GC=F ÷ SI=F), SGE premium (now computable — SGE and LBMA both ingested) | analysis-time computation or a tiny derived-series pass | each maps to an active desk theme |

### Verified working but deliberately not added

- **OANDA MarketPulse** (`marketpulse.com/feed/`) — live but carries a
  single, stale item from both vantage points; not worth a slot.
- **SilverSeek** (`silverseek.com/rss.xml`) — alive (10 items, carries
  weekly COT writeups) but leans gold-bug; revisit if the desk wants a
  silver-specialist voice.
- **StockCharts articles** (`articles.stockcharts.com/feed`) — alive but
  overwhelmingly US-equity-centric; gold appears rarely.
- **Yahoo GC=F finer bars** — `interval=1m&range=8d` and `5m/60d` both
  work on the existing endpoint if intraday technicals are ever needed.

### Confirmed dead — do not re-chase

- **DailyFX** (Akamai hard-block, the one high-quality TA casualty),
  DailyForex (feed objects deleted from S3), TradingView (no first-party
  RSS), GoldSeek (feed stranded in 2020), 321gold / SafeHaven / Sprott /
  GoldMoney (no feeds), Incrementum (feed dead since 2018), IG /
  Interactive Brokers (no public RSS).
- **Stooq** — now behind a JS proof-of-work challenge (the reason
  `gold_spot` moved to Yahoo in the first place); permanently off the list.
- **Lease-rate feeds** — Monetary Metals and GoldBroker publish charts
  only; Bloomberg/LSEG paid. In-house computation is the only free path.
- **COMEX delivery notices** (PDF-only), **India/UAE import stats**
  (PDF/dashboard), **Borsa Istanbul premium** (paid), **DGJG Dubai retail
  rate** (no feed; derivable in-house).
- **DXY vol index** — discontinued; no free replacement exists.

## Addendum 2026-08-17 — maritime and Iranian press

Filling the two gaps the 2/9/16 Aug retros kept raising. Every candidate was
fetched **and** extracted from the host through production code; extraction
matters as much as the feed, because a page that extracts to nothing is worse
than one that fails outright (see `gnews_gold`, removed 08-08).

### Added

- **gcaptain** (`https://gcaptain.com/feed/`) — 12 items/3d, articles extract
  1.7–3.0k chars. Playbook #4 already assumed this source existed; now it does.
- **Maritime Executive** (`https://maritime-executive.com/articles.rss`) —
  56 items/5d, extracts 2.4–3.7k. Serves playbook #9's incident-feed
  requirement, since UKMTO's own pages 403 any plain client.
- **Mehr News English** (`https://en.mehrnews.com/rss`) — 30 items/21h,
  extracts 867–966 chars (Mehr's copy is genuinely short). One side's account:
  playbook #1 and #8 apply.

### Verified working but deliberately not added

- **Splash247** (`https://splash247.com/feed/`) — 10 items/6h, fine feed.
  gcaptain + Maritime Executive already cover the corridor; a third maritime
  source is volume without new information.

### Rejected, with reasons

- **IRNA English** (`https://en.irna.ir/rss`) — feed parses and looks healthy,
  but article pages extract to **~70 chars**. Extraction "succeeds" and says
  nothing, which poisons any article read rather than failing loudly. Restore
  only behind a real extractor for that site.
- **Tasnim English** — DNS does not resolve from the host.
- **Press TV** — TLS chain fails to verify from the host (`CERTIFICATE_VERIFY_FAILED`).

### Note on volume

These three add roughly +45 items/day into a pipeline whose news channel
already posts ~90 messages a weekday, so all three run hourly rather than
half-hourly. Flash tiering
(`docs/superpowers/specs/2026-08-17-flash-tiering-brief.md`) is what makes the
channel readable; until it ships, expect a modest bump.
