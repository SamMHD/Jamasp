# Flash tiering — design brief

**Date:** 2026-08-17
**Status:** brief for review — no code written, no spec finalised
**Problem owner:** the news channel posts ~90 messages a weekday; roughly 10 matter

## The problem, measured

Flashes posted per day on the host, 2026-08-08 → 08-17:

```
  2   20   71   94   89   90   72   23   27   46
```

Weekdays settle near **90/day** — one message every ten minutes, peaking at 40 in
the 16:00 Dubai hour. Weekends fall to ~25, so the volume is purely a function of
news supply, not of a bug.

Reading all 90 headlines from 2026-08-13, about **10** were desk-relevant: US PPI
4.7% vs 4.9% expected, three Fed speakers, the 30-year auction at 5.216%, the ECB
September-hike poll, ADNOC vessels attacked in Hormuz, the Pentagon's
"indefinite blockade" line, Jackson Hole. The remaining ~80 fell into six buckets:

| Bucket | Count (est.) | Examples from 08-13 |
|---|---|---|
| Scheduled TA columns | ~15 | "EUR/USD Daily Outlook", "USD/JPY Daily Outlook", "USD/CHF Daily Outlook", "Elliott Wave View: Oil", "Sunset Market Commentary" |
| Non-gold cross-asset | ~20 | ~15 oil/gas forecasts, S&P 500 record high, "The AI boom", Argentina shale, Rotterdam refinery blast |
| Mechanical prints | ~12 | PBOC USD/CNY fix — posted **twice**, the estimate and then the actual — FX option expiries, Spain inflation, RBNZ survey, 30-yr mortgage rate |
| Regional service journalism | ~10 | "What UAE residents need to know today" *and* "…tonight", same day |
| Same story, many angles | ~15 | six messages all reporting gold pulling back after CPI/PPI; ~8 separate Hormuz items |
| Not news | ~5 | "How the First World War Destroyed the Gold Standard" |

Five sources produce 437 of the last 534 posts: forexlive 143, gulf_news 82,
actionforex 72, fxempire_forecasts 71, investing_commodities 69.

## Cause

Three separate facts, none of them a malfunction:

1. **The gate is binary relevance, phrased at maximum permissiveness.**
   `jamasp/flashtext.py:26` asks for `gold: true` if the item "plausibly bears on
   the gold market **at all**", then names interest rates, the dollar, inflation
   data and geopolitical risk. Under that instruction nearly every macro and FX
   headline is a *correct* `true`. **No materiality dimension exists anywhere in
   the pipeline.**
2. **There is no volume regulation.** `max_posts_per_tick: 10` × 96 ticks/day is
   a burst cap with a 960/day ceiling. Each tick decides in isolation; nothing
   asks whether a story outranks what already went out today.
3. **Dedup folds events, not narratives.** The decide prompt correctly treats
   "same underlying event" as the dup test, which is why six different
   gold-pulled-back stories ship as six distinct flashes.

## Chosen direction

Tiered output. The triage model assigns a materiality tier alongside the existing
`gold` / `dup_of` verdict; the tier decides the delivery channel.

- **Top tier** → posts immediately to the news channel, as today.
- **Middle tier** → accumulates and goes out as one periodic Persian rollup.
- **Bottom tier** → dropped from the channel. Still ingested, still in the DB,
  still reachable by `inbox`, the brief, and the scan — a dropped flash is not
  lost information.

Proposed tier definitions:

| Tier | Meaning | Examples |
|---|---|---|
| 5 | moves gold now | FOMC decision, CPI/PPI surprise, central-bank gold buying, war escalation touching supply or safe-haven demand |
| 4 | changes the setup | Fed speakers shifting rate odds, ECB/BOJ policy signals, large ETF or physical flows, an auction tail |
| 3 | context | routine macro prints landing in line, geopolitical follow-ups, mining corporate news |
| 2 | adjacent | oil, equity or FX moves with no gold transmission channel |
| 1 | noise | scheduled TA columns, the PBOC daily fix, option expiries, retail price notes, history and opinion |

Applying that to 08-13's 90 items gives roughly: tier 4–5 ≈ 10, tier 3 ≈ 25,
tier 2 ≈ 25, tier 1 ≈ 30.

## Open decisions

Each carries my recommendation. Override any of them.

**1. Rollup content depth.**
*Recommend:* one Persian line per story, grouped under theme headers (rates &
dollar / geopolitics / metals & mining), each line carrying the fact and its
transmission channel. One batched model call per rollup — no article extraction
for middle-tier items, so ~6 calls/day replace ~80 extract-plus-write pairs.
*Rejected:* keeping the full title/summary/impact treatment and merely batching
it. That preserves today's per-item cost and would run each rollup near
Telegram's 4096-char cap, forcing splits and undoing the point.

**2. Which tiers reach the rollup.**
*Recommend:* **tier 3 only.** Tier 2 is defined by having no gold transmission
channel, so a line about it carries nothing a gold desk can act on. This differs
from the "tier 2-3 accumulate" option chosen in conversation — flagging it
explicitly. The arithmetic is the argument: tier 3 alone is ~25 items/day ≈ 6
lines per rollup, comfortable to scan; tiers 2-3 together are ~50/day ≈ 12 lines,
back to a wall of text.

**3. Cadence.**
*Recommend:* four fixed Dubai times — 08:00, 12:00, 16:00, 20:00 — each covering
the window since the last. Fixed local times are predictable for the desk in a
way a rolling four-hour offset is not. Skip the send entirely when a window holds
fewer than three items rather than posting a near-empty rollup.

**4. Where scoring happens.**
*Recommend:* extend the existing decide call to return `tier` alongside `gold`
and `dup_of`. It already reads every candidate's headline and lede in one batched
Sonnet call, so the tier costs nothing extra. No second model pass.

**5. Per-source policy.**
*Recommend:* none for now. It is tempting to hard-cap the two TA mills
(actionforex, fxempire_forecasts — 143 posts in 7 days, mostly scheduled
columns), but that is a second filtering mechanism competing with the tier score.
Let the score handle them, then revisit with a week of tier data showing what
each source actually produces.

**6. Daily volume budget.**
*Recommend:* none. A hard cap on top-tier posts would have to choose between
stories already judged material, and on a genuine event day suppressing the
fourth FOMC-related flash is the wrong instinct. If the scoring works the count
self-regulates; if it does not, a cap only hides that.

## Found on the way — out of scope unless you want it

- **`skipped_stale` = 4139.** `classify_batch_max: 30` starves older candidates
  when ingest spikes, so they age past the 6h window unclassified — 235 dropped
  on 08-11 alone. About a third of all items are already being cut from the
  channel, by arrival order rather than by importance. Tiering does not fix this;
  it makes it worse, because a starved item might have been a tier 5.
- **The narrative-dedup gap** behind the six gold-pulled-back messages. Tiering
  reduces the symptom (most of those six are tier 3) without addressing the cause.

## Expected outcome

Roughly **10 immediate flashes plus 4 rollups ≈ 14 messages/day**, against ~90
today. Model cost falls too: ~80 extract-plus-write pairs per day become ~10,
plus 4 batched rollup calls.

## Next step

On approval of this brief, the decisions above get folded into a full design doc
at `docs/superpowers/specs/2026-08-17-flash-tiering-design.md`, then an
implementation plan via the writing-plans skill.
