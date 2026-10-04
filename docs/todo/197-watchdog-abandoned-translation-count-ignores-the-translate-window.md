---
id: 197
title: "The watchdog's \"translate gave up on N items\" count is not scoped to the translate window, so a one-off quota incident fires the same alert every day forever"
status: open
opened: 2026-10-04
owner: unassigned
closed:
---

## Problem

`jamasp/watchdog.py` (`abandoned` block, ~line 255) counts
`items WHERE headline_fa IS NULL AND fa_attempts >= MAX_ATTEMPTS` with no
date bound, and the comment says so deliberately ("regardless of the
window"). But `translate.py`'s `pending_rows` is bounded by `translate_from`
/ `window_days` and `--force`'s `rearm()` is scoped to the same window, so a
row abandoned *outside* the window can never be retried by the job or
re-armed by the operator — and the watchdog reports it every morning as if
it were actionable.

## Why it matters

The desk Telegram has received the identical line — "translate gave up on
1318 items after 3 attempts; check jamasp-translate.service and `jamasp
translate --check`" — at 05:00Z on every one of the eight days 28 Sep–4 Oct
(and before). `jamasp translate --check` returns ok each time. A daily alert
that carries no new information is the shape that trains the desk to ignore
the watchdog, which also carries the OAuth-expiry and run-cap warnings. The
27 Sep retro read it as "covered by todos 017/019/025/026"; 019 and 025 are
closed and the line is unchanged, so nothing open actually owns it.

## Evidence

- `notify_log`: watchdog messages 28 Sep, 29 Sep, 30 Sep, 1 Oct, 2 Oct,
  3 Oct, 4 Oct (05:00:02Z–05:00:32Z) all carry "gave up on 1318 items".
- `items`: 2,604 rows with `fa_failed_at` set; `min/max(fa_failed_at)` =
  2026-09-20T11:44:42Z / 2026-09-21T15:58:21Z — the codex quota incident
  (todo-025, done). `fa_error` on 1,331 of them is a "translator exit 1 …
  chatgpt.com/codex/settings/usage" quota string; 1,273 carry NULL.
- `jamasp translate --check` (4 Oct 16:0xZ, this retro): "ok — the
  translator answered".
- `watchdog.py:255-266`: the count is gated only on `translate_has_run`.
- `translate.py` `rearm()`: "Scoped to the window because rows outside it
  are never translated anyway." The watchdog does not apply the same logic.

## Fix

Either (a) apply the translate window to the watchdog count (same
`translate_from` / `window_days` predicate `pending_rows` uses), so rows the
job will never touch are not reported; or (b) report the *delta* — rows
newly abandoned since the previous watchdog run — and mention the lifetime
total at most once a week (the retro could carry it). Separately, give an
operator a one-shot reset for a resolved incident (`jamasp translate --force
--since 2026-09-20` or a `--retire-abandoned` that sets a terminal status),
so the 2,604 rows from 20–21 Sep stop counting as live failures.

## Done when

The 05:00Z watchdog message stops repeating an unchanged abandoned count
for rows the translate job cannot reach; a fresh outage still surfaces as
a new count the morning after it happens. Confirm by reading
`notify_log` for three consecutive days after the change.

## Related

- todo-025 (closed): the quota fan-out that produced these rows.
- todo-017, todo-026: other translate-visibility gaps; neither owns this
  line.
- 4 Oct retro report (`reports/2026/10/2026-10-04-retro.md`, verified-this-
  run section).
