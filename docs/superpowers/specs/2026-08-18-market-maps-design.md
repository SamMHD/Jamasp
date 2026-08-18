# Market maps — design

**Date:** 2026-08-18
**Status:** design approved in conversation; no code written
**Supersedes nothing.** Extends the flash tiering work (`2026-08-17-flash-tiering-brief.md`,
landed in #10) and the panel overview (`2026-08-10-panel-overview-redesign-design.md`).

## The ask

Two treemaps at the top of the panel, in the shape of a Bourse market map: one for
fundamental news, one for technical signals. Tile **area** carries importance, tile
**colour** carries direction. Both maps' importance weights carry a **multiplier
learned from what gold actually did**, refit daily and reshaped weekly.

The purpose is a short-to-mid-term trading read at a glance — "where is the pressure
coming from, and what is the tape saying about it" — without reading ninety headlines.

## What is already true

Facts established by reading the repo, which the design builds on rather than rebuilds:

- **`flash_items.tier` is live.** `flashtext.py` already asks the batched triage call
  for a 1–5 materiality tier on every candidate, and `db.py:113` stores it. The
  importance axis exists in production today; only direction is missing.
- **TradingView's scanner serves any field, keyless.** `sources.yaml:329` already
  pulls six fields through `parse_tradingview_scanner_json`; the endpoint also serves
  `MACD.macd`, `Stoch.K/D`, `ADX`, `CCI20`, `BB.upper/lower`, `W.R`, `Mom`, `AO`,
  EMA/SMA at every length, and `Pivot.M.Fibonacci.S1…R3`, with `|1W` / `|240`
  timeframe suffixes. Widening the set is a config change plus `TV_FIELD_SUFFIXES`
  entries — no indicator math for the live map.
- **TradingView serves no history.** One call returns one instant;
  `prices.py:139` stamps it with fetch time because the payload carries no timestamp.
  Anything that needs a historical series must compute it.
- **Candidate starvation was already fixed** in #10. `_OLDEST_RESERVE` holds back part
  of each batch for items nearest ageing out, and the alarming `skipped_stale: 4139`
  was mostly `skipped_born_old`. Map coverage is not compromised by it.
- **Feed dates could be silently centuries wrong until 2026-08-18.** `#16` fixed
  `rss._published_at`: feeds carrying a raw Unix epoch in `<published>` had it read
  as a year, so `1786971720` became `1786-08-01`. Items ingested **before** that fix
  keep their corrupt dates. Both maps window on `published_at`, and Plan 2's training
  rows are keyed to when a story was live — so a sanity floor on `published_at` is a
  correctness requirement here, not hygiene.
- **The same URL can appear as several items** (`docs/todo/002`). `rss.item_id()`
  hashes `(source, url, headline)`, so a publisher rewriting a live article's headline
  mints a new item for a URL already seen. One Investing.com URL produced six items in
  six distinct clusters; 4% of all flashes to 2026-08-17 were repeats of an
  already-posted URL.

- **The panel has validated viz tokens** (`globals.css:40-51`) produced by the
  dataviz validator, and pure-derivation modules with tests (`lib/technicals.ts`,
  `lib/health.ts`). This design follows both patterns.
- **`sources.yaml:324` deliberately excludes TradingView's aggregate `Recommend.All`**
  — "technicals annotate the macro read, they must not originate calls." **This
  design does not reverse that decision**: neither map produces an aggregate verdict.

## Decisions

| | |
|---|---|
| Fundamental tile | two levels — theme box containing story tiles |
| Window | **today / this week** toggle; flat within each window, no decay constant |
| Colour | green ↔ red diverging, gray midpoint, **45° hatch on bearish tiles** |
| Encoding | area = importance, colour intensity = conviction |
| Technical verdict | **none** — no aggregate number anywhere |
| Signal set | ~42 — 14 signals × {daily, weekly, 4h}, less the ones with no intraday variant |
| Signal source | TradingView live; computed history for fitting, TV as test oracle |
| Estimator | ridge regression, theme- and signal-level |
| Cadence | daily fit owns the numbers; weekly retro owns the shape |
| Retro authority | may reshape freely; may **pin** a weight with reason + expiry |
| Layout | both maps as page hero, side by side; nothing existing removed |

### Rejected alternatives, and why

- **Flat story-only map** (no theme grouping) — loses the "which sector is driving"
  read that makes a market map legible at a glance.
- **Exponential decay on tile area** — a tunable half-life the toggle makes
  unnecessary. Two explicit windows each mean exactly one thing.
- **Classic trading green/red `#16a34a`/`#dc2626`** — measured **ΔE 5.0** under
  deuteranopia against the panel's dark surface. Hard FAIL; it collapses.
- **Blue↔red (ΔE 21.6) and amber↔teal (ΔE 12.4)** — both pass cleanly, both rejected
  in favour of the trading convention plus secondary encoding.
- **An aggregate technical verdict** — would reverse a decision made on purpose, and
  would let an oscillator basket write the macro narrative.
- **Scan-agent scoring** — better-informed per item, but 12 runs/day against a 20-run
  cap, unread items only, up to 2h stale, and it changes scan's contract.
- **A second vendor for indicator history** (Twelve Data) — does not remove the
  two-implementations risk, it hides it: no way to measure the gap against TV.

## 1 · Fundamental: story → tile

### Scoring

The existing batched triage call gains two fields and a theme slot. No new model
call, no agent-run budget — it already reads every candidate's headline and lede.

```
DECIDE_HEADER  (jamasp/flashtext.py)
  1. "gold":       true | false          (existing)
  2. "dup_of":     id | null             (existing)
  3. "tier":       1-5                   (existing)
  4. "direction": -2 | -1 | 0 | +1 | +2  (new — for gold, not for the world)
  5. "conviction": 0.0 - 1.0             (new)
  6. "theme":      one of the fixed slots (new)
```

`direction` is explicitly *gold-relative*: a dollar rally is `-2` even though it is
good news for the dollar. The prompt must say so, or the model will score sentiment.

### Storage

A new table, not a column on `flash_items`. That table records **delivery state**
(posted / held / dup / skipped); a score is a property of the **item**, needed by the
map whether or not the item ever reaches the channel.

```sql
CREATE TABLE item_scores (
  item_id    TEXT PRIMARY KEY REFERENCES items(id),
  tier       INTEGER NOT NULL,   -- 1..5, the existing scale
  direction  INTEGER NOT NULL,   -- -2..+2, gold-relative
  conviction REAL    NOT NULL,   -- 0..1
  theme      TEXT    NOT NULL,   -- fixed taxonomy slot
  scored_at  TEXT    NOT NULL
);
CREATE INDEX idx_item_scores_theme ON item_scores(theme);
```

### Theme taxonomy

A **fixed list in `config/weights.yaml`**, because the ridge fit needs stable columns:

`rates_dollar`, `geopolitics`, `physical_cb`, `etf_flows`, `supply_mining`, `other`

`state/watchlist.yaml` is unchanged and unrelated — it holds what Jamasp is currently
tracking. The taxonomy is a slower-moving thing that only the retro changes, and a
change to it triggers a refit from history.

### Area and colour

```
area   = tier_weight[tier] × multiplier[theme]
         tier_weight = {5:100, 4:60, 3:30, 2:10, 1:3}   (config, retro-tunable)

colour = (direction / 2) × conviction        → signed intensity s ∈ [-1, +1]
         |s| < 0.15          → gray midpoint
         0.15 ≤ |s| < 0.55   → mid step of the arm
         |s| ≥ 0.55          → pole
```

No decay term. **Today** = since Dubai midnight; **week** = trailing 7 days; flat
within each.

A tier-5 story with `conviction: 0.1` renders **big and gray** — it matters and it is
unresolved, which is the correct thing for the desk to see.

### Coverage

The map shows only items the triage classified: gold-relevant, and seen within
`flash.max_age_hours: 6`. Items that arrived already older (`skipped_born_old`) carry
no score and cannot appear. **The map footer states its coverage** — item count,
window, and the number of unscored items in range — rather than implying completeness.

Two guards apply wherever scores are **read** — by the map and by Plan 2's training
rows alike. Both are read-time, not write-time: `item_scores` keeps one row per item,
and collapsing on the way in would destroy information that cannot be recovered.

1. **Collapse on URL, keeping the highest tier.** Per `docs/todo/002` one URL can
   hold several item ids under rewritten headlines. On the channel that is a
   credibility problem; on a treemap it is an *arithmetic* one — six tiles for one
   story is six times the area in that theme, which then inflates that theme's
   exposure in every training row it appears in and biases the fitted multiplier.
   Collapsing on URL is mechanical and exact, unlike the narrative-dedup problem.
2. **Reject implausible `published_at`.** Anything before `_MIN_SANE_YEAR` (2000) is
   a pre-`#16` epoch-parsing artefact. Excluded from both windows and from the fit.
   The count of rejected items belongs in the coverage footer, so a silent shortfall
   reads as a number rather than an empty corner of the map.

## 2 · Technical: signal → tile

### Live values

Widen `tv_gc_technicals`'s `fields=` list and add `|1W` and `|240` variants. Values
land in the existing `prices` table as `GC_RSI14`, `GC_RSI14_1W`, `GC_RSI14_4H`.
**No schema change.**

Fourteen signals across five families, each at three timeframes:

| family | signals |
|---|---|
| trend | 50/200 cross, price vs 200DMA, MACD, ADX |
| momentum | RSI14, Stochastic, Williams %R |
| levels | Fib 0.618, Fib 0.5, pivot R1/S1, round number |
| volatility | Bollinger %B, ATR percentile, GVZ |
| positioning | CFTC net spec |

GVZ and CFTC net spec have no meaningful 4h or weekly variant; they occupy the daily
timeframe only, so the true count is **42 minus those duplicates**. The signal list is
config, not code.

### Classification

TradingView serves values, not calls — and `Recommend.*` stays excluded. A pure module
(`jamasp/signals.py`) maps each raw value to a state in [−1, +1], where **positive
means bullish for gold**:

```
RSI:        clamp((50 - rsi) / 20)          # 30 → +1 oversold/bullish, 70 → -1
MACD:       clamp((macd - signal) / atr)
50/200:     +1 above / -1 below             # discrete
Bollinger:  clamp((0.5 - pct_b) * 4)
...
```

### Area and colour

**Area = the learned multiplier alone.** This makes the Bourse analogy exact: there,
market cap is stable and sets the *shape* while the day's move sets the *colour*. Here
the multiplier — how much a signal has historically mattered — sets the shape, and the
current state sets the colour. The map's shape becomes a picture of what has been
learned; its colour is today's read.

### Confidence

Because 4h may ship unfitted (see §3), a measured weight and a guessed one must be
distinguishable or the map lies about what it knows. **Low-confidence tiles get a
dashed outline; fitted tiles solid.** Deliberately orthogonal to both fill colour and
the bearish hatch, so all three encodings coexist without collision.

## 3 · The learning loop

### Training rows

One row per hour:

```
features  6 theme exposures  = Σ tier_weight of stories live that hour,
                               BEFORE any multiplier (that is what we solve for)
       + 42 signal states    ∈ [-1, +1]
target    gold forward return over horizon H, divided by ATR14
```

Dividing by ATR makes the target comparable across volatility regimes.

**H is a hyperparameter the retro owns, default 24h**, and the map states it. This is
what keeps 42 signals honest without three separate weight sets: a weekly signal
legitimately earns a small weight at a 24h horizon, and that smallness *is* the
finding.

### Estimator

Ridge regression over ~48 features.

**On "prior 1.0" — stated precisely, because the naive reading is false.** Ridge
shrinks coefficients toward **zero**, not toward one. The multiplier is `β / β̄`,
normalised so the mean is 1.0. Shrinking coefficients toward zero therefore shrinks
the *multipliers* toward each other — that is, toward 1.0. The desired behaviour falls
out of standard ridge, but only when the normalisation is written this way.

Ridge is also what solves **attribution**: when PPI and a Hormuz headline are both
live and gold moves +0.6%, regression splits the credit. Averaging realised moves per
theme would pay both in full and inflate every weight permanently.

### Negative coefficients — an explicit rule

A multiplier is a size scalar; negative is meaningless as area. A theme fitting
negative means stories scored **bullish** were followed by gold going **down** — which
is evidence the **direction scoring** is wrong for that theme, not that the theme
should shrink.

> Multipliers clamp to **[0.25, 3.0]**. A negative fit clamps to the floor **and
> raises a flag the retro must address.** Silently taking `abs()` would bury the
> single most useful thing the regression can report.

### Confidence

The coefficient's standard error against n. Below threshold → the dashed outline of
§2. Thresholds live in `config/weights.yaml`.

### Backfill

The fit needs history TradingView cannot serve, so history is **computed**:

- `jamasp/indicators.py` — pure, computes the same fourteen signals from OHLC bars.
- Source: Yahoo daily bars over a deep range; weekly resamples from daily.
- **TV is the test oracle**: assert `|computed − TV_live| < tol` at the same instant.
  Formula drift fails CI instead of silently skewing the weights. This turns the
  duplication from a risk into a check, and is the reason computing is acceptable at
  all.

**Measured 2026-08-18:** Yahoo serves GC=F at `range=730d&interval=1h` →
17,395 bars (first 2024-03-26, last 2026-08-18, i.e. the full ~2-year window
at hourly granularity), resampling to ~4,349 4h bars — well past the ~750-bar
threshold needed to fit. Shallower windows also came back live (`60d&1h` →
1,429 bars, `1mo&1h` → 619 bars), so the endpoint is healthy at every depth
tried; `730d` is simply the deepest `1h` range Yahoo accepts. The 4h signals
therefore ship **fitted**, rendered **solid** per the confidence treatment of
§2.

Fundamental multipliers **cannot** be backfilled — there is no historical corpus of
scored news — so they start at 1.0 and warm over months while the technical half ships
fitted. That asymmetry is expected and is exactly what the confidence treatment
communicates.

### Cadence and authority

**Daily owns the numbers. Retro owns the shape.**

`jamasp weights fit` — a deterministic CLI command on its own timer. Full refit from
all history; milliseconds on a few thousand rows. No agent run, no token cost, same
class as the flash pipeline. Full refit rather than an incremental nudge: idempotent,
reproducible, no drift.

The weekly retro may:

- split or merge a theme, retire or add a signal
- change `tier_weight`, horizon H, ridge α, confidence thresholds
- **pin** a weight it can justify against what the data cannot see

Any structural change triggers a refit from history. A pin carries a written reason
and an expiry, and **expired pins lapse automatically at fit time** — no cleanup step
to forget.

### Where things live

Matching the project's existing config/state split:

| | owner | holds |
|---|---|---|
| `config/weights.yaml` | retro — *intent* | taxonomy, signal list, `tier_weight`, H, ridge α, thresholds, **pins** |
| `state/weights.json` | daily fit — *measurement* | fitted β, n, SE, `fitted_at` |
| `weight_fits` table | daily fit | full trajectory, so a multiplier's drift is inspectable |

```yaml
# config/weights.yaml — pin example
physical_cb:
  pin: 1.45
  reason: "PBoC resumed buying after an 18-month pause; the n=3 fitted
           sample is all quiet-tape prints"
  set: 2026-08-24
  expires: 2026-09-21
```

Effective weight = active pin if present, else fitted, then clamped to [0.25, 3.0].
The panel marks a pinned tile so measured and asserted numbers are never confused.

## 4 · The panel

Layout: both maps as page **hero**, side by side, above the existing content. Nothing
is removed — the status strip, technical panel, stance card, horizon strip, news flow,
drivers grid and forecast record all keep their current place and slide down.

- **`lib/marketmap.ts`** — pure derivation: scored rows → tiles with x/y/w/h via
  squarified treemap. Testable without rendering, matching `lib/technicals.ts`.
- **`components/market-map.tsx`** — server-rendered SVG, like the existing
  `spot-chart` and `arc-gauge`. The page is already `force-dynamic`.
- **Both maps are the same component with different inputs.** This is most of why the
  two-map ask is cheap.
- **The today/week toggle is a URL search param** (`?w=week`), not client state. It is
  a view change, not a write, so it keeps the panel server-rendered and leaves the
  read-only-DB / writes-through-CLI contract untouched.
- **Hover** via native SVG `<title>`: headline, tier, direction, conviction, source,
  age. Zero JS.
- **Legend is mandatory.** The 5-step ramp with labels, plus "hatched = bearish" and
  "dashed = not yet fitted". At ΔE 6.9 the legend is part of what makes the palette
  legal, not decoration.
- **Below a size threshold a tile keeps its rectangle and drops its label.** Never
  clipped text.

### Palette

Measured with the dataviz validator against the panel's real surfaces
(`#171717` dark, `#ffffff` light). Both modes pass; dark is the design target.

| role | hex |
|---|---|
| bullish pole | `#1baf7a` |
| bullish mid | `#3e6d55` |
| neutral midpoint | `#3a3a38` |
| bearish mid | `#854741` |
| bearish pole | `#e34948` |

Worst adjacent CVD separation **ΔE 6.9 (deuteranopia)** — inside the 6–8 floor band,
which is legal **only** with secondary encoding. The 45° hatch on bearish tiles is
that encoding, and it is required, not optional: it works at any tile size, which the
signed score label does not.

## Testing

- `lib/marketmap.ts` — squarified layout: areas proportional, no overlap, no overflow,
  degenerate inputs (one tile, zero-area, empty theme) handled.
- Colour mapping — every `(direction, conviction)` pair lands on the intended step;
  boundary values at 0.15 and 0.55 pinned.
- `jamasp/indicators.py` — golden vectors per indicator, **plus the TV-oracle test**.
- Weight fit — a synthetic series with known coefficients recovers them; the negative
  clamp fires and flags; pins override; expired pins lapse.
- Triage prompt — a fixture batch scores directions gold-relative, not sentiment-wise
  (the dollar-rally case explicitly).
- E2E — both maps render with real fixture data; the legend is present; coverage
  footer states the real count.

## Rollout

1. Probe Yahoo intraday depth — decides whether 4h ships fitted.
2. `direction` / `conviction` / `theme` into the triage call and `item_scores`. Scores
   begin accumulating immediately; nothing renders yet.
3. Widen the TV field list. Signals begin accumulating.
4. `indicators.py` + backfill + the TV-oracle test.
5. `weights fit` + config/state files + timer.
6. `lib/marketmap.ts`, then `market-map.tsx`, then the page.

Steps 2 and 3 are worth landing first regardless of the rest: they cost little and
every day they run is a day of training data the fit will want.

## Out of scope

- The **narrative**-dedup gap from the tiering brief (six "gold pulled back" stories
  as six items). Tiering reduced the symptom; the map will show it as several mid-size
  tiles in one theme, which is arguably an improvement — but the cause is untouched.
  This is distinct from the **same-URL** repost of `docs/todo/002`, which the map does
  handle, by the read-time collapse above: same-URL is exactly detectable, same-narrative
  is not.
- Repairing the corrupt pre-`#16` `published_at` values in the live database. The read
  guard excludes them; backfilling correct dates is a separate job and needs the
  original feed payloads, which are not retained.
- Any aggregate buy/sell verdict, on either map.
- Multi-horizon weight sets. One H, retro-tunable.
- Agent overrides of a story's direction. The fitted-vs-pinned pattern exists for
  weights only; extending it to individual scores is a later question, and worth
  asking only once the base layer has run.
