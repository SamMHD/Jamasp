---
name: brief
description: Produce the daily Jamasp morning brief — read the news delta, analyze gold-market impact, publish the English report, send the Persian Telegram summary, update stance.
---

# Daily Brief

Work through these steps in order. Today's date in Dubai (UTC+4) determines
the report path: `reports/YYYY/MM/YYYY-MM-DD-brief.md`.

## 1. Load context (cheap, do all of it)

- Read `state/stance.md`, `state/playbook.md`, `state/watchlist.yaml`,
  and `state/calendar.yaml`.
- Run `uv run jamasp ingest` (refresh), then `uv run jamasp price`,
  `uv run jamasp inbox`, `uv run jamasp calendar`, `uv run jamasp wakeup list`,
  and `uv run jamasp predictions due`.

## 1.5 Micro-retro (yesterday's calls)

- For each prediction printed by `jamasp predictions due` (already annotated
  with the actual gold move): judge it honestly and score it —
  `uv run jamasp predictions score <id> --outcome hit|miss|unclear --note "<why>"`.
- Summarize hits/misses in one short "Yesterday's calls" section of today's
  report. No scored predictions → skip the section.
- A miss with a nameable cause → append one bullet to
  `state/lessons-inbox.md` (date, observation, suggested rule). You may
  adjust `state/stance.md`; NEVER touch `state/playbook.md` (that's /retro's).

## 2. Analyze

- Identify the 3–7 developments since the last brief that actually matter for
  gold (rates, dollar, real yields, central-bank demand, geopolitics, physical
  flows). Ignore noise; the inbox is pre-deduped but not pre-ranked.
- For at most 2–3 items where the headline+lede is insufficient AND the impact
  is material, run `uv run jamasp extract <url>`; if the text is long,
  summarize via a subagent.
- Form a view: what changed versus `stance.md`? Be explicit when you are
  updating or contradicting yesterday's view, and say why.

## 3. Write the report (English)

Create `reports/YYYY/MM/YYYY-MM-DD-brief.md`:

    # Jamasp Brief — YYYY-MM-DD (Dubai)

    ## Market snapshot
    <output of `jamasp price`, one line of interpretation>

    ## What happened
    <3–7 bullets: development → mechanism → expected gold impact (direction + conviction)>

    ## Outlook
    <your stance for the coming days: base case, key risks, what would change your mind>

    ## Watching
    <upcoming events/data with dates (Dubai time), scheduled wakeups (from jamasp wakeup list), and watchlist changes>

## 4. Update state

- Rewrite `state/stance.md` (≤1 page: current view, key drivers, conviction).
- Add/remove `state/watchlist.yaml` entries (new themes get `since: <today>`).
- Calendar maintenance: newly discovered events worth acting on go into
  `state/calendar.yaml` (with why + action), and each gets a wakeup:
  `uv run jamasp wakeup add "<ISO>" deepdive "<precise task>"`
  (e.g. transcript analysis 30 min after a speech).
- Record today's falsifiable outlook claims:
  `uv run jamasp predictions add "<claim>" --direction up|down|flat
  --horizon-days N --confidence 0.x` — 1–3 per brief, only claims you'd
  accept being scored on.
- First brief of the week (Monday): prune watchlist entries stale for
  4+ weeks (check each `since:`), noting removals in the report.

## 5. Deliver

- Compose a Persian summary (≤12 lines: خلاصه بازار، مهم‌ترین رویدادها، چشم‌انداز)
  ending with the report path. Numbers/tickers stay Latin.
- Send it: pipe the summary text to `uv run jamasp notify -`.

## 6. Close out

- Run `uv run jamasp inbox --mark-read`.
- `git add reports/ state/ && git commit -m "jamasp: brief YYYY-MM-DD"`.
