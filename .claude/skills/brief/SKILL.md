---
name: brief
description: Produce the daily Jamasp morning brief — read the news delta, analyze gold-market impact, publish the English report, send the Persian Telegram summary, update stance.
---

# Daily Brief

Work through these steps in order. Today's date in Dubai (UTC+4) determines
the report path: `reports/YYYY/MM/YYYY-MM-DD-brief.md`.

## 1. Load context (cheap, do all of it)

- Read `state/stance.md` and `state/watchlist.yaml`.
- Run `uv run jamasp ingest` (refresh), then `uv run jamasp price` and
  `uv run jamasp inbox`.

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
    <upcoming events/data with dates (Dubai time), and watchlist changes>

## 4. Update state

- Rewrite `state/stance.md` (≤1 page: current view, key drivers, conviction).
- Add/remove `state/watchlist.yaml` entries (new themes get `since: <today>`).

## 5. Deliver

- Compose a Persian summary (≤12 lines: خلاصه بازار، مهم‌ترین رویدادها، چشم‌انداز)
  ending with the report path. Numbers/tickers stay Latin.
- Send it: pipe the summary text to `uv run jamasp notify -`.

## 6. Close out

- Run `uv run jamasp inbox --mark-read`.
- `git add reports/ state/ && git commit -m "jamasp: brief YYYY-MM-DD"`.
