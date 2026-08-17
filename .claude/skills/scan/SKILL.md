---
name: scan
description: 2-hourly urgent-news scan — read the delta against the stance; stay silent unless something demands desk attention.
---

# Urgent Scan

Cheap run. Target: a few thousand tokens, sub-minute. The default outcome is
**silence**.

## 1. Load (only this)

- Read `state/stance.md`.
- Run `uv run jamasp inbox` and `uv run jamasp price`.
- If the stance carries a live level claim, run
  `uv run jamasp predictions due --open` and read its `window_high` /
  `window_low` before repeating that claim's status. An overnight touch that
  mean-reverts is invisible in the latest print, and a scan is exactly where
  stale narrative status gets copied forward.

## 2. Decide

Freshness first: if the price snapshot or inbox is stale (old timestamps,
market closed, ingest clearly not running), don't analyze bad inputs — treat
it as a no-alert run; mention staleness only if it persists across scans
(that's watchdog territory).

Urgency test — does anything in the delta meet at least one of:
- surprise data print or central-bank action that contradicts the stance;
- geopolitical shock with a plausible gold transmission channel;
- gold move ≥ 1.5% since the last price snapshot in `stance.md`'s context.

If NO (the normal case): run `uv run jamasp inbox --mark-read`, commit
(`jamasp: scan YYYY-MM-DD HH:MM`), and exit. **No report, no Telegram, no
stance edit.**

## 3. If YES — alert

- In the final hours before a high-impact calendar event, pre-positioning
  moves are expected — no fresh directional calls on them; if alerting at
  all, frame it as event-pending.
- Compose a terse bilingual alert: 2–4 lines Persian (numbers/tickers Latin)
  then 1–2 lines English: what happened, expected gold impact, whether the
  stance changes. Send via `uv run jamasp notify -`.
- If the stance changes materially, rewrite `state/stance.md` (≤1 page) and
  say so in the alert.
- If the item deserves a focused read (statement, transcript, dataset),
  schedule it instead of doing it now:
  `uv run jamasp wakeup add "<ISO time, soon>" deepdive "<precise task>"`.
- Record any new falsifiable view:
  `uv run jamasp predictions add "<claim>" --direction up|down|flat --horizon-days N --confidence 0.x`.

## 4. Close out

- `uv run jamasp inbox --mark-read`
- `git add -A state/ && git commit -m "jamasp: scan YYYY-MM-DD HH:MM"`
