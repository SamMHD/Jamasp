# Future sources — research doc

Status: research only. Nothing here is wired into `config/sources.yaml` yet.
Researched 2026-07-31.

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
| World Gold Council (gold.org) | `https://www.gold.org/rss.xml` | free | High — official demand-trends data, central-bank buying commentary, ETF-flow analysis, written for exactly this audience | ✅ Verified: valid RSS 2.0, live items. Article-page extractability (Cloudflare or not) not yet tested — try `jamasp extract` on one item before committing |
| LBMA gold price benchmark (AM/PM auction) | `https://prices.lbma.org.uk/json/gold_am.json` and `.../gold_pm.json` | free | High — this *is* the global benchmark spot price (vs. our current GC=F futures proxy) | ✅ Verified: 200, valid JSON, history back to 1968. Caveat: ICE Benchmark Administration (IBA) licenses real-time/historical redistribution of the LBMA benchmark for commercial use — fine for internal desk reference, worth a light legal check before publishing derived numbers externally |
| LBMA news/press | no discoverable RSS (`/rss`, `/news-insights` → 404) | — | Medium | ❌ No feed found; would need scraping, not recommended |
| BullionVault (gold-news blog) | `https://www.bullionvault.com/gold-news/rss` | free | Medium — independent retail-flow-adjacent commentary | ⚠️ Timed out from this sandbox on every attempt (curl and WebFetch); re-check from Hetzner |
| Metals Focus | no free feed; research reports/subscriptions (Gold Focus, Precious Metals Investment Focus, Gold Mine Cost Service) | paid, price not published — contact for quote | High-quality supply/demand and mine-cost data, but built for scheduled reports not a live feed | Not RSS/API-shaped — a "buy the annual report and read it manually" source, not an ingest candidate |

## 2. Macro/central-bank primary sources (beyond Fed/Treasury)

| Name | Feed/API | Cost | Value | Feasibility |
|---|---|---|---|---|
| ECB press releases | `https://www.ecb.europa.eu/rss/press.html` | free | High — euro-area rate decisions move DXY and thus gold | ✅ Verified: valid RSS 2.0, live items |
| Bank of England | `https://www.bankofengland.co.uk/rss/news` (index at `/rss`) | free | Medium-high — GBP/gilt moves, less direct gold impact than Fed/ECB | ❌ 403 on both curl and WebFetch — bot-protected, same posture as blocked news sites. Not fixable via WARP |
| IMF | `https://www.imf.org/en/news/rss`, `https://www.imf.org/en/rss-list/feed?category=WHATSNEW` | free | Medium — reserve-asset commentary, occasional gold-reserve mentions in Article IV reports | ❌ 403 on all paths tried — bot-protected |
| BIS press releases | `https://www.bis.org/doclist/all_pressrels.rss` | free | Medium — central-bank-of-central-banks commentary, useful for systemic-risk framing | ✅ Verified valid RDF/RSS 1.0 via WebFetch (direct curl timed out from this sandbox — re-check from Hetzner, but the WebFetch result is a good sign it's not bot-blocked) |
| BoJ | not checked — no obvious English RSS found in this pass | free (if exists) | Medium — yen carry-trade unwinds are a live gold theme | Needs a follow-up search; skip for now |
| PBoC / SAFE gold reserves | no RSS/API — monthly "Official Reserve Assets" release on the SAFE website, gold reported in USD only (needs conversion to oz/tonnes using month-end price) | free but not machine-readable | High — China's 20-month buying streak is one of the desk's active themes | Not feasible as an automated feed; the WGC's China commentary (see §1) and secondary reporting (Kitco/Reuters-style writeups, when reachable) are the practical proxy |
| IMF IFS central-bank gold reserves by country | `gold.org/goldhub/data/gold-reserves-by-country` (WGC repackages IMF IFS data) | free, dashboard-only, no documented public API | High context, low ingest-value | Goldhub is a login-gated dashboard, not a feed — manual reference, not a source-config candidate |

## 3. Positioning/flows data

| Name | Feed/API | Cost | Value | Feasibility |
|---|---|---|---|---|
| CFTC Commitments of Traders (Socrata API) | `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?commodity_name=GOLD` (legacy report; disaggregated report is a different dataset id) | free, no key required | High — weekly speculative positioning is a core gold-desk signal | ✅ Verified: 200, valid JSON via WebFetch (direct curl timed out from sandbox — likely a Socrata rate-limit/network quirk, re-check from Hetzner). Updates Fridays, data through the prior Tuesday |
| SPDR GLD daily holdings | `https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_archive_EN.csv` | free | High — GLD tonnage changes are a widely watched institutional-flow proxy | ✅ Verified: 200, CSV, daily NAV/holdings/premium-discount history |
| iShares SLV holdings | `https://www.ishares.com/us/products/239855/ishares-silver-trust-fund/1467271812596.ajax?fileType=csv&fileName=SLV_holdings&dataType=fund` | free | Medium — silver is a secondary desk interest, correlated but distinct flow signal | ✅ Verified: 200, CSV |
| COMEX warehouse stocks (CME Metals Stocks report) | `https://www.cmegroup.com/delivery_reports/Metals_Stocks.xls` | free | Medium-high — registered/eligible gold inventory levels matter around delivery months | ⚠️ Timed out from this sandbox; re-check from Hetzner. If blocked, CME also publishes the same data via a daily bulletin page that may be scrape-friendlier |

## 4. Economic calendars

| Name | Feed/API | Cost | Feasibility |
|---|---|---|---|
| ForexFactory calendar | `ffcal_week_this.xml` and similar | free (if reachable) | ❌ 403 — confirmed scraping-hostile, matches its reputation |
| FXStreet economic calendar | `/economic-calendar/rss` | free (if reachable) | ❌ 403 — same Cloudflare posture as the already-blocked FXStreet news site |
| BLS (Bureau of Labor Statistics) release feed | `https://www.bls.gov/feed/bls_latest.rss` | free | ❌ 403 in this test — worth a re-check from Hetzner since BLS is a US government site less likely to be a hard bot-wall than a commercial one; could be a transient block |
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
| Gulf News | `https://gulfnews.com/feed` (redirects to `/stories.rss`) | free | Medium — regional business/markets context, UAE-specific angle the international wires don't cover | ✅ Verified: valid RSS 2.0 via WebFetch |
| Zawya (Refinitiv-owned MENA business news) | guessed paths (`/en/rss`, `/sitemaps/en/rss`, old `rssfeeds/regional.xml`) all 403/404, or timed out | free (if reachable) | High — MENA business-desk-grade coverage would be a strong regional complement | ⚠️ Inconclusive from this sandbox; worth a direct re-check from Hetzner before writing it off, since some paths returned 403 (bot-wall) rather than clean 404 (wrong URL) |
| The National (UAE) | site confirms it publishes RSS feeds (per its own `/uae/rss-feeds-1.536712` help page) but exact section URLs weren't discoverable via search or guessing | free | Medium — UAE/Gulf business angle | ⚠️ Inconclusive; the site itself claims RSS exists (\"click the RSS icon top-right\"), so this is worth a manual look at the live page rather than further guessing, then re-verify from Hetzner |
| Khaleej Times | `/rss/business` | free (nominally) | Medium | ❌ Returns HTTP 200 but the body is an HTML consent-wall page (Securiti.ai cookie script), not RSS/XML — a reminder that status code alone isn't sufficient proof of a working feed |

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
| Mining Weekly | `https://www.miningweekly.com/page/home/feed` | free | Medium — African/global mining-sector coverage, complements Mining.com | ✅ Verified: 200. (A guessed alternate path, `/page/rss-feed/feed:americas-home`, was 403 — use the working one) |
| Northern Miner | `https://www.northernminer.com/feed/` | free | Medium — Canadian mining-sector trade press, junior-miner-heavy | ✅ Verified: 200 |
| Junior Mining Network | `/rss.html` | free (if reachable) | Medium — junior-miner news flow, more speculative/volatile signal | ❌ 403 — bot-protected |
| Mining Journal | `/rss` | free (if reachable) | Medium | ❌ 403 — bot-protected |
| ETF/fund-flow trackers (etf.com, VettaFi, WGC's own Gold ETF flows page) | no free machine feed found this pass | mostly free to read, no API without a data-vendor contract | High conceptually (institutional flow is a top-tier signal) | Best free proxy remains the SPDR GLD CSV (§3) — a dedicated cross-fund tracker would need a paid data vendor (e.g. via TradingEconomics or a specialist ETF-flow API) |
| X/Twitter signal (trader chatter, Fed-watcher accounts, geopolitical break-news) | X API v2 | Basic tier ($200/mo) closed to new signups as of Feb 2026; current model is pay-per-use: $0.015/post created, $0.005/post read (capped 2M reads/mo), or Enterprise for bulk | High signal speed for breaking macro/geopolitical news, but noisy and adversarial to filter | Feasible cost-wise at low volume (a narrow filtered stream of ~10-20 accounts would stay in the low tens of dollars/month), but this is a different ingestion shape than RSS — would need a dedicated poller, dedup logic, and real editorial judgment about which accounts are worth the noise. Treat as a v2 project, not a drop-in source |
| Reuters (business RSS) | `arc/outboundfeeds/rss/category/business/` | free (if reachable) | High — but already established as DataDome-blocked, confirmed again this pass (404/blocked) | ❌ Not fixable client-side. Only real path in is a paid LSEG/Reuters license (§6) |

---

## Recommended next additions

1. **LBMA gold AM/PM auction JSON** (`prices.lbma.org.uk/json/gold_*.json`) — free, verified live, and it's the actual global benchmark gold price rather than a futures proxy (GC=F). Near-zero integration cost; add as a second `price_api` source alongside `gold_spot`.
2. **World Gold Council RSS** (`gold.org/rss.xml`) — free, verified live, and it's the one source in this whole list written by and for the gold-market audience Jamasp serves. Only open question is article-page extractability; test one `jamasp extract` call before committing.
3. **CFTC Commitments of Traders (Socrata JSON)** — free, no key, weekly speculative-positioning data with no equivalent already in `sources.yaml`. This fills a real gap: today's sources are all news/price, nothing on positioning.
4. **SPDR GLD daily holdings CSV** — free, verified live, standard institutional-flow proxy that every gold desk already watches informally; costs nothing to formalize.
5. **Gulf News RSS** (`gulfnews.com/feed`) — free, verified live, and the only regional/Dubai-adjacent source in this research that actually works out of the box; gives the desk a UAE-market lens the international wires don't carry.

Lower priority but worth a second pass from the Hetzner host specifically
(where several checks were inconclusive due to this sandbox's network path,
not confirmed blocks): BIS press RSS, CFTC Socrata direct reachability,
CME COMEX warehouse stocks, Zawya, The National, and BullionVault.
