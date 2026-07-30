# Jamasp — Design Spec

**Date:** 2026-07-31
**Status:** Approved by Saman (this session)

Jamasp (جاماسپ, the sage-advisor of the Shahnameh) is an autonomous financial
forecast and advisory agent for a gold trading company based in Dubai. It reads
world news, produces market-impact briefs for gold, self-schedules deeper
investigations around upcoming events, and — in a later phase — factors the
company's physical position (e.g. −10 kg) into refill-timing advice.

## Goals & principles

1. **Awareness per token.** Claude Code (headless) is the reasoning runtime, but
   raw web content never enters an agent context. Deterministic scripts fetch,
   dedupe, and compact everything first.
2. **Autonomy through tools, not long-running sessions.** The agent requests
   future work (wakeups); deterministic infrastructure executes it. No idle
   agent loops.
3. **Everything in one git repo.** Code, config, state, and reports live
   together; every agent run commits, so `git log` is the audit trail of what
   Jamasp knew and concluded, when.
4. **The CLI is both ops tool and agent toolbox.** Any command the agent uses,
   the operator can run by hand, and vice versa.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Runtime | Always-on Linux VPS, Claude Code headless (`claude -p`) fired by systemd timers |
| Auth | Claude subscription logged in on the VPS (shared rate limits → token discipline matters; safety cap on runs/day) |
| Delivery | Phase 1: markdown reports in repo (canonical) + Telegram push. Phase 4: email digest, web dashboard |
| Language | English canonical reports; Persian summaries/alerts to Telegram |
| Sources | Free wires/RSS + official calendars + free market-data APIs to start; paid feeds later as drop-in `sources.yaml` entries |
| Cadence | Daily Dubai-morning brief + self-scheduled event wakeups + 2-hourly urgent scans during market hours |
| Position data | Phase 3, manual entry (CLI/Telegram) to start |
| Ingestion summarization | Batched Haiku pass at ingest time writes uniform one-line ledes and cluster labels |

## Architecture

Three moving parts on the VPS:

1. **Ingesters** — cron/systemd, every 15 min, near-zero tokens. Fetch sources,
   normalize, dedupe, cluster; a batched `claude -p --model haiku` digest pass
   writes ledes.
2. **Dispatcher** — systemd timer, every 5 min, zero tokens. Fires due fixed
   runs and due wakeup-queue entries as `claude -p "/brief|/scan|/deepdive"`.
3. **Jamasp runs** — headless Claude Code sessions; the only significant token
   consumers.

### Repo layout

```
Jamasp/
├── CLAUDE.md                  # Jamasp persona, rules, tool usage contract
├── .claude/skills/            # /brief, /scan, /deepdive workflow skills
├── jamasp/                    # Python package: the CLI toolbox
│   ├── ingest/                # rss, calendar, prices fetchers
│   ├── cli.py                 # single `jamasp` entry point
│   └── ...
├── config/
│   ├── sources.yaml           # feeds, calendars, price APIs (declarative, drop-in)
│   └── settings.yaml          # schedules, Telegram ids, caps, truncation limits
├── state/                     # agent working memory (small, committed)
│   ├── jamasp.db              # SQLite: items, dedupe index, inbox flags, wakeups, extract cache, error log
│   ├── watchlist.yaml         # tracked themes/entities, each with `since` date
│   ├── calendar.yaml          # upcoming events Jamasp cares about
│   ├── positions.yaml         # phase 3: current book
│   └── stance.md              # rolling market view, rewritten each brief, ≤1 page
├── reports/YYYY/MM/           # dated briefs & deep-dive analyses (archive + long-term memory)
├── docs/superpowers/specs/    # design docs (this file)
├── ops/                       # systemd units/timers, install script, watchdog
└── tests/                     # pytest + fixtures
```

## Ingestion layer

**Sources (`config/sources.yaml`).** Declarative entries: `{type: rss|calendar|price_api, url, interval, topic}`.

Starting set:
- *Wires/RSS:* Reuters (top + markets), Kitco, FXStreet gold, Investing.com
  commodities, MarketWatch, Fed press releases, US Treasury press releases.
- *Calendars:* economic-calendar source (CPI, NFP, FOMC dates) + central-bank
  speech schedules → `events` table, separate from the news inbox.
- *Prices:* XAU/USD spot, DXY, 10Y real-yield proxy — snapshotted each ingest
  cycle so briefs compute moves from local history, no live lookups.

**Normalization & dedupe.** Item = `{id (content hash), source, published_at,
headline, lede ≤200 chars, url, topic}`. SQLite rejects seen hashes.
Cross-source near-duplicates are clustered by fuzzy headline match; the agent
sees one item with `also_reported_by: [...]`.

**Haiku digest pass.** After each ingest cycle, one batched
`claude -p --model haiku` call writes uniform one-line ledes for new items and
labels clusters. One call per cycle, not per item.

**Inbox.** `jamasp inbox` prints unprocessed items as compact JSONL, newest
first, hard-capped (default 120; overflow degrades to newest-plus
count-by-topic summary). `jamasp inbox --mark-read` closes the delta at the end
of a run. The inbox header carries system notes (dead sources, cap warnings).

**On-demand depth.** `jamasp extract <url>` → trafilatura article text,
truncated (~4k tokens), cached in SQLite. The only path for web content into
agent context.

**Failure isolation.** Per-source failures never block others; error counts in
SQLite; sources dead >24 h surface in the inbox header and the daily brief.

## Agent runs

Three skills in `.claude/skills/`:

### `/brief` — daily, 07:30 Dubai
Reads `stance.md`, `watchlist.yaml`, `calendar.yaml`, `positions.yaml`
(phase 3), wakeup list, inbox delta. Produces:
1. `reports/YYYY/MM/DD-brief.md` (English): what happened, meaning for gold,
   updated outlook, today's watch items (including scheduled wakeups).
2. Persian summary → Telegram.
3. Rewritten `stance.md` (≤1 page).
4. Calendar maintenance: newly discovered events → `calendar.yaml` **and**
   `jamasp wakeup add` (e.g. transcript analysis 30 min after a speech).
5. Optional deep-dives dispatched to subagents.
6. Weekly (first brief of the week): prune stale watchlist entries.

### `/scan` — every 2 h, 09:00–23:00 Dubai
Reads inbox delta + `stance.md` only. Rule: *if nothing materially changes the
stance or demands desk attention, output nothing and exit.* Urgent items
(surprise data print, geopolitical shock, gold ±1.5 % move) → terse
Persian+English Telegram alert, optionally schedule a deep-dive. Target cost:
a few thousand tokens, sub-minute.

### `/deepdive <task>` — on demand via wakeup queue
Focused single-topic run carrying its task text (e.g. "read FOMC statement +
presser transcript, compare to stance §rates, assess gold impact"). Uses
`jamasp extract`; output appended to the day's report + Telegram note if the
stance changes.

### Subagent & memory discipline
- Long documents are read by subagents (Haiku/Sonnet, low effort) that return
  conclusions, not content. CLAUDE.md rule: *raw source text never enters the
  main session; only tool output and subagent conclusions do.*
- `stance.md` = always-loaded working memory. `reports/` = archive, consulted
  via grep/glob only when history is needed, never bulk-loaded.
- Every run ends with `git commit`.

## Scheduler, autonomy & delivery

**Fixed schedule (systemd timers, Dubai time):**

| Timer | When | Fires |
|---|---|---|
| ingest | every 15 min | `jamasp ingest` + Haiku digest |
| brief | 07:30 daily | `claude -p "/brief"` |
| scan | every 2 h, 09:00–23:00 | `claude -p "/scan"` |
| dispatcher | every 5 min | due wakeup-queue entries |
| watchdog | 09:00 daily | plain-text health check |

**Wakeup queue.** `jamasp wakeup add "<ISO time>" <run-type> "<task text>"` →
SQLite row. Dispatcher fires it on time as `claude -p "/<run-type> <task>"`
(`deepdive` in the common case), marks done or `failed` after 2 retries. `jamasp wakeup list` feeds the morning
brief's "today I'm watching" section. Properties: agent requests, infra
executes; wakeups carry full intent for the fresh session; visible schedule.

**Safety cap.** `settings.yaml` `max_agent_runs_per_day`; exceeding it defers
runs and sends a Telegram warning — never silent drops, never runaway loops.

**Delivery.** `jamasp notify telegram --level brief|alert` via bot API: Persian
summary + reference to the English report. Alerts: what happened, expected gold
impact, stance change or not. Email (phase 4) is another `notify` backend over
the same report files; dashboard (phase 4) is a static site generated from
`reports/` + `state/`.

## Error handling & ops

- **Agent runs:** dispatcher wraps every `claude -p` — nonzero exit or timeout
  (15 min brief/deepdive, 5 min scan) → one retry, then plain-text Telegram
  failure notice. Expected-but-missing report file counts as failure.
- **Rate limits:** dispatcher detects CLI rate-limit errors → defer with
  backoff to the queue + Telegram notice if a brief is delayed (subscription
  quota is shared with Saman's interactive use).
- **Watchdog (no LLM):** checks ingestion ran within the hour, yesterday's
  brief file exists, wakeup queue is draining; Telegrams on violation. Jamasp
  being down is never silent.
- **Git as ops log:** every run commits.

## Testing

- **pytest** over the deterministic core: feed parsing, dedupe/clustering,
  inbox capping/overflow, wakeup scheduling, notify formatting. Fixtures in
  `tests/fixtures/`.
- `--dry-run` for notify (print, don't send) and dispatcher (show what would
  fire).
- **E2E smoke test** (manual, token-spending): seed DB from fixtures, run
  `/brief`, assert report + state updates. Run before deploys, not in CI.
- **Skills** validated by supervised phase-1 runs on Saman's Mac with human
  review before VPS deployment.

## Roadmap

| Phase | Scope | Exit criterion |
|---|---|---|
| 1 — MVP (Mac) | Repo scaffold; `jamasp` CLI (ingest, digest, inbox, extract, price, notify); starting `sources.yaml`; `/brief` skill; Telegram bot; manual daily runs | A week of daily briefs Saman finds genuinely useful |
| 2 — Autonomy + VPS | Wakeup queue + dispatcher; `/scan`, `/deepdive`; calendar ingestion; watchlist; systemd timers; watchdog; deploy script | Jamasp self-schedules an event analysis correctly, unprompted |
| 3 — Position awareness | `positions.yaml`; `jamasp position set` (CLI and/or Telegram); refill-timing advice in briefs/alerts | Useful "cover now / wait" advice on a real −10 kg scenario |
| 4 — Surfaces & upgrades | Email digest backend; static dashboard; paid feeds as new sources | — |

## Out of scope (for now)

- Automated trading or order execution — Jamasp advises, humans trade.
- Paid news/data integrations (designed-for via `sources.yaml`, not built).
- Multi-user access control; the Telegram group is the trust boundary.
