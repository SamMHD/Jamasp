---
id: 012
title: jamasp-weights dies on Yahoo's 730d hourly pull, taking signals and the fits with it
status: in-progress
opened: 2026-09-05
owner: unassigned
closed:
---

## Problem

`jamasp-weights.service` has failed on **every** run since it was installed.
Its first `ExecStart`, `jamasp bars backfill`, gets `429 Too Many Requests`
from Yahoo for `range=730d&interval=1h` and exits 1. Because a failed
`ExecStart` in a `Type=oneshot` unit aborts the ones after it, `signals
refresh` and `weights fit` have never run on the host.

Three separate things are unresolved here:

1. **Why Yahoo 429s `range=730d&interval=1h`** while serving
   `range=1d&interval=1h` from the same host, IP and headers all day long,
   and what the hourly pull should ask for instead.
2. **The unit's abort chain.** Even with bars partially fixed (see Related),
   a non-zero `bars backfill` still stops `signals refresh` and `weights
   fit`. Making the pipeline resilient needs an exit-code policy decision —
   see **Fix** — not just a code change.
3. **Nothing notices the quiet half.** The watchdog checks ingest freshness
   and the OAuth token; it does not check whether `bars`, `signal_states` or
   `weight_fits` are advancing. The loud daily alert happened to cover this,
   but any fix that makes the unit exit 0 on partial success removes the only
   signal.

## Why it matters

The learning loop shipped in #21 (2026-08-24) has never produced a single
number. `weight_fits` holds 0 rows and `state/weights.json` does not exist,
so the market maps have run on the hand-authored priors in
`config/weights.yaml` for their entire life — not stale multipliers, *no*
fitted multipliers. Nothing on the panel or in the brief says so.

`signal_states` is frozen at `2026-08-31T04:45:43Z` (a manual run during the
#23 work) and cannot advance, because the only scheduled caller of `signals
refresh` is the unit that dies at step 1. Ten of its eleven rows are the
TradingView fallback added in #23 — a fallback introduced *because* bars were
missing, which is the same root cause treated as a permanent condition rather
than an outage.

The weekly retro silently skips section 4.6 ("if it does not exist yet, no
fit has run — skip this section this week") — every week, with no
accumulating complaint.

## Evidence

Gathered 2026-09-05 against the production host, read-only.

- **12 consecutive failures**, one per day, `2026-08-24T23:31:58Z` through
  `2026-09-04T23:36:04Z`, all `status=1/FAILURE`, `Result=exit-code`. Unit is
  `failed` right now; next run 2026-09-05 23:30 UTC. Zero successful runs in
  the journal, which reaches back to the 2026-07-31 boot.
- The traceback is identical every time, and always inside the *first*
  ExecStart:
  ```
  File "/home/jamasp/Jamasp/jamasp/cli.py", line 333, in bars_backfill
    written = bars_mod.backfill(conn, symbol)
  File "/home/jamasp/Jamasp/jamasp/ingest/bars.py", line 194, in backfill
    hourly = parse_yahoo_bars(fetch(HOURLY_URL))
  File "/home/jamasp/Jamasp/jamasp/net.py", line 43, in get_with_fallback
    resp.raise_for_status()
  httpx.HTTPStatusError: Client error '429 Too Many Requests' for url
  'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=730d&interval=1h'
  ```
  It appears twice per run: once direct, once through the
  `JAMASP_EXTRACT_PROXY` (WARP) fallback in `net.py:37-44`. Both egress paths
  429.
- **It is not an IP-wide block and not a burst effect.** `gold_spot`
  (`config/sources.yaml:224`) polls
  `query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1d&interval=1h` — the
  same host, endpoint, symbol and `BROWSER_HEADERS` — every 15 minutes and
  succeeds: `source_last_fetch.gold_spot` = `2026-09-05T19:16:12Z`, `prices`
  has 2146 `GC` rows. `journalctl -u jamasp-ingest` contains **zero**
  occurrences of `429 Too Many`. Across all units for the last 30 days there
  are exactly **2 per day, all from jamasp-weights** — the direct and proxied
  attempts of this one URL. The small-range request succeeds ~96x/day from
  the same IP minutes before the large-range one fails.
- **DB state:** `bars` = **0 rows** (all timeframes). `weight_fits` = 0 rows.
  `state/weights.json` absent — `state/` holds only `calendar.yaml`,
  `jamasp.db`, `jamasp.db.passlock`. `signal_states` = 11 rows, newest
  `2026-08-31T04:45:43Z`, sources: 10 `tradingview`, 1 `series`, **0 `bars`**.
- **The alerts all delivered.** `notify_log` has one
  `⚠️ خطای سرویس — jamasp-weights.service` per failure, every one `ok=1`.
  `meta.alert_last.jamasp-weights.service` = `2026-09-04T23:36:05Z`. The
  alerting path is healthy; this is not an alerting bug.
- **`weights fit` itself is innocent** and would degrade gracefully: with too
  few rows `run_fit` returns `None` (`jamasp/fit.py:123-128`) and the CLI
  prints `weights fit: not enough rows for any fit yet` and exits 0
  (`jamasp/cli.py:371-372`). The unit's failure is 100% attributable to
  `bars backfill`.
- **Negative result — do not repeat it:** probing the four range tokens
  (`1d`, `730d`, `2y` with `interval=1h`; `5y` with `interval=1d`) from a
  local laptop returned **HTTP 429 for all four**, including the `1d` case
  that demonstrably works in production. That IP is blocked outright, so a
  local probe cannot distinguish these hypotheses. Testing the range token
  needs an egress Yahoo will actually serve. It was **not** re-probed on the
  production host, deliberately: Yahoo rate-limits by burst and re-tripping it
  risks the live 15-minute ingest tick.
- `bars.py:110-112` claims "Measured 2026-08-18: 17,395 hourly bars", so the
  URL did serve once, from whatever machine that measurement was taken on.
  Whether that was the production host is unknown — the journal's first
  weights run is 2026-08-24 and it already 429'd.

Ranked hypotheses for (1), still open:

| # | Hypothesis | What would distinguish it |
|---|---|---|
| A | Yahoo meters by response *cost*; ~17.4k bars exceeds the anonymous quota while 24 bars does not | Request `range=2y&interval=1h` (same depth, enum token) from a Yahoo-serving IP. Still 429 → cost, not token |
| ~~B~~ | ~~`730d` is not a valid `range` enum and Yahoo answers invalid tokens with 429~~ | **REFUTED 2026-09-05** — see Update below |
| C | Yahoo tightened anonymous chart access since 2026-08-18 and now requires a crumb/cookie for deep history | Both `2y` and `730d` 429 while `1d` succeeds from the *host*, and a crumbed request succeeds |

A and B are cheap to separate with one request from a suitable IP; C is the
fallback reading if neither range token works. Note the `5y&interval=1d`
daily leg has never actually been exercised in production — it is unreached,
not known-good.

## Fix

Three pieces, in order of independence:

1. **Land the bars-independence fix** (already written, see Related): each
   timeframe stands alone, so an hourly 429 no longer costs the daily pull.
   This alone gets `bars` populated with 1d/1w rows if the daily leg works.
2. **Settle the hourly URL.** Test hypotheses A/B/C from an egress Yahoo
   serves. If `range=2y&interval=1h` works, it is a one-token change in
   `bars.py:113-116`. If nothing works anonymously, either drop to
   `period1`/`period2` epoch paging, accept daily-only bars, or pick a
   different provider — that is a source decision, not a refactor.
3. **Decide the exit-code policy for the unit, and cover it in the
   watchdog.** The open question: should `bars backfill` exit non-zero when
   *some* timeframes landed? Exiting non-zero keeps the alert loud but keeps
   `signals refresh` and `weights fit` from ever running. Exiting zero lets
   the pipeline finish but makes a permanently-dark hourly feed silent.
   Recommended shape: `bars backfill` exits 0 when it wrote anything (warning
   on stderr about the leg that failed) and non-zero only when it wrote
   nothing; then add a watchdog check for `bars`/`signal_states`/`weight_fits`
   freshness so partial darkness still reaches the desk within a day. Splitting
   the three `ExecStart` lines into separate units is the alternative and
   costs an alert per stage.

Do not simply prefix the `ExecStart` lines with `-`: that converts a
12-day-old loud failure into a permanent silent one.

## Done when

- `bars` has rows for at least the `1d`/`1w` timeframes on the production
  host, advancing daily.
- `weight_fits` is non-empty and `state/weights.json` exists, or `weights
  fit` is reporting a specific, understood reason it cannot fit yet.
- `signal_states` advances on the daily timer, with at least the daily
  timeframe sourced from `bars` rather than the TradingView fallback.
- `jamasp-weights.service` is no longer in `systemctl --failed`.
- Something fails loudly within 24h if any of the above stops advancing —
  verified by making it stop, not by reading the config.

Legitimate alternative outcome: if no anonymous Yahoo endpoint serves deep
hourly history, abandon the 1h/4h timeframes explicitly, record that decision
here, and narrow `config/weights.yaml` to the timeframes that do exist —
rather than leaving a permanently-failing fetch in place.

## Related

- Introduced by #21 `73620a1` "Market maps: the learning loop (plan 2 of 3)"
  (2026-08-24) — the same day the failures start.
- #23 `f82af38` "feat(signals): read current states from TradingView when bars
  are missing" (2026-08-31) worked around the symptom; `jamasp/signals.py:219-228`
  documents the three state sources and says outright "this host has no bars".
- `docs/todo/003-tradingview-weekly-4h-fields-return-null-for-gold.md` — the
  TradingView fallback cannot cover 4h/weekly, so it is not a substitute for
  bars.
- The `alerting` skill: this is the alerting system working exactly as
  designed. Twelve alerts, all delivered, one per day, suppression never
  masking anything.


## Update 2026-09-05 — probe result and the fixes that landed

### The probe settled one hypothesis and killed the easy fix

One approved request from the production egress, direct, no proxy, no retry:

```
GET https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=2y&interval=1h
STATUS: 429   BYTES: 19   BODY: Too Many Requests
```

`2y` is an unambiguously valid Yahoo `range` enum token, and it is rejected
exactly like `730d`. **Hypothesis B is refuted**, and with it the hoped-for
one-token fix: changing `range=730d` to `range=2y` in `bars.py:113-116` would
change nothing. That change was NOT made.

The three data points now read:

| Request | Result | Frequency |
|---|---|---|
| `range=1d&interval=1h` | 200 | ~96×/day, indefinitely |
| `range=730d&interval=1h` | 429 | 12/12 runs |
| `range=2y&interval=1h` | 429 | 1/1 probe |

Same host, same IP, same headers, minutes apart. Depth is the discriminator,
not the token spelling. **A** (metering by response cost) and **C** (deep
history now needs a crumb/cookie) both survive, and the probe budget was one
request so they were not separated. For the purpose of fixing this they
collapse to the same operational conclusion: **anonymous deep hourly history
from `query1.finance.yahoo.com` is not available from this host**, and no
amount of range-token fiddling will change that.

**Still genuinely unknown: whether the daily leg works.** `range=5y&interval=1d`
is ~1,250 bars against the hourly leg's ~17,400, so under (A) it should
succeed and under (C) it may not. It has *never once been executed in
production* — the unit has always died on the hourly leg first. Deploying the
change below is what answers this, and the answer decides whether this item
closes or turns into a source migration.

### What landed in the worktree (not deployed, not committed)

1. **`backfill()` legs are independent.** `jamasp/ingest/bars.py` — each
   endpoint runs and commits on its own; an hourly 429 no longer costs the
   daily pull. Returns a `BackfillResult(written, failures)` instead of
   raising on the first leg error.
2. **Exit-code policy** (`jamasp/cli.py`): `bars backfill` exits 0 whenever
   *anything* was written, printing `WARNING bars GC: 1h leg failed — …` to
   stderr for each dead leg; exits non-zero only when nothing landed. This is
   what lets `signals refresh` and `weights fit` finally run.
3. **Watchdog freshness checks** (`jamasp/watchdog.py`) — the pairing that
   keeps (2) from converting a loud failure into a silent one:
   `BARS_STALE_DAYS = 4`, `SIGNAL_STATE_STALE_DAYS = 4` (both follow the
   market calendar — a Monday's newest daily bar is legitimately Friday's,
   ~3 days old, so 4 clears the worst legitimate gap by a day),
   `WEIGHT_FIT_STALE_DAYS = 3` (wall-clock; three consecutive missed nightly
   refits). Empty tables are violations, not passes — `MAX(ts)` over no rows
   is NULL and a naive comparison would report a never-run pipeline as
   healthy, which is the exact state being caught here.

Verified against a **copy of the real production database** (2026-09-05,
bars 1d = 0 rows, weight_fits = 0 rows, signal_states frozen at
2026-08-31T04:45:43Z), `watchdog.check()` at the normal 09:00 Dubai slot:

```
- bars have never been backfilled (no 1d rows); check jamasp-weights.service
- signal states stale: newest 2026-08-31T04:45:43Z (5d old, > 4d); check jamasp-weights.service
- weight fit has never landed (weight_fits empty) — the maps are running on unfitted priors; check jamasp-weights.service
```

Test suite: 480 passed, 4 skipped (10 new tests, each written failing first).

### What remains

- **Item 1 is still open**: whether deep hourly history can be had at all, and
  from where. Blocked on seeing whether the daily leg survives deployment.
- **No unit-file change is needed.** The three `ExecStart` lines stay exactly
  as they are — the exit-code policy achieves the same result without
  weakening the failure signal, which prefixing them with `-` would have done.
- If the daily leg also 429s, the 1h/4h timeframes should be abandoned
  explicitly and `config/weights.yaml` narrowed to what exists, rather than
  leaving a permanently-failing fetch in place. That decision is not taken
  here.
