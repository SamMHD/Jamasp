---
id: 191
title: "`jamasp-authd` fires a Telegram failure alert on every deliberate restart — exit 143 under SIGTERM is not a success status, so `systemctl restart` looks like a crash; 7/7 lifetime authd alerts are this shape"
status: open
opened: 2026-09-27
owner: unassigned
closed:
---

## Problem

`ops/systemd/jamasp-authd.service` runs `uv run jamasp authd` with
`Restart=always` and `OnFailure=jamasp-alert@%n.service`. On
`systemctl restart` (or `stop`), systemd sends SIGTERM; the process exits
with status 143 (128 + 15) rather than dying by signal, so systemd records
`code=exited, status=143` → `Failed with result 'exit-code'` → fires
`OnFailure` → the desk gets a "⚠️ خطای سرویس" message for a unit that was
restarted on purpose and is already back up.

Journal, 26 Sep 2026 06:34Z (from the alert body itself):

```
Stopping jamasp-authd.service - Jamasp panel — Cloudflare Access JWT sidecar…
jamasp-authd.service: Main process exited, code=exited, status=143/n/a
jamasp-authd.service: Failed with result 'exit-code'.
jamasp-authd.service: Triggering OnFailure= dependencies.
Started jamasp-authd.service …
```

And the alert's own state block reads `result: success` /
`state: active/running`, because by the time `jamasp alert` gathers, the
unit has already restarted.

## Why it matters

- **Every authd alert ever sent has been a false positive.** `notify_log`
  rows for `jamasp-authd.service`: 27 Aug 06:37Z, 2 Sep 06:30Z, 11 Sep
  06:47Z, 19 Sep 06:15Z, 24 Sep 06:31Z, 25 Sep 13:07Z, 26 Sep 06:34Z — all
  at deploy hours, three in this week alone (the 25 Sep one lines up with
  PR #47's move to `jamasp.mkagent.co`). Seven alerts, zero incidents.
- The desk chat is reserved for briefs, scan alerts and *real* failure
  notices (CLAUDE.md). An alert channel that cries wolf on every deploy
  trains the desk to skip the ⚠️ lines — the 13 Sep retro failure alert
  (todo-013) went unnoticed for a week in exactly that chat.
- `jamasp-panel.service` has `Restart=on-failure` and the same
  `OnFailure=` line; whether it exhibits the same behaviour depends on how
  `next start` handles SIGTERM. Check it in the same change.

## Fix

Pick one; the first is a two-line unit change and needs no code:

1. **`SuccessExitStatus=143`** (or `SuccessExitStatus=SIGTERM 143`) in
   `[Service]` of `jamasp-authd.service` and, if it exhibits the same
   shape, `jamasp-panel.service`. systemd then treats the SIGTERM exit as
   clean; `OnFailure` does not fire on a restart, and still fires on a real
   crash.
2. Alternatively `KillSignal=SIGINT` if `jamasp authd` exits 0 on SIGINT —
   verify, don't assume.
3. Not preferred: make `jamasp alert` suppress when `Result=success` and
   `ActiveState=active` at gather time. That would also mute a real
   crash-loop that happened to be mid-restart when the alerter ran.

Whichever: reinstall the unit, `systemctl daemon-reload`, then test both
ways per the `alerting` skill — `systemctl restart jamasp-authd` must
produce **no** alert, and a forced failure must still produce one.

## Done when

- `systemctl restart jamasp-authd.service` adds no row to `notify_log`.
- A forced failure of the same unit still alerts (alerting skill recipe).
- `.claude/skills/alerting/SKILL.md` notes that exit 143 under SIGTERM is
  a clean stop and which units carry `SuccessExitStatus`.

## Related

- `.claude/skills/alerting/SKILL.md` — the unit template and test recipe.
- `docs/todo/013` — the real failure alert that went unnoticed in the same
  chat.
- `reports/2026/09/2026-09-27-retro.md`, Verified-this-run.

## Update 2026-10-04 (retro)

4 Oct retro: two more — 1 Oct 06:28:50Z and 4 Oct 06:24:12Z alerts; the user-level journal shows `jamasp authd listening on 127.0.0.1:3301` at 06:28:20Z and 06:24:12Z respectively (a fresh start at the alert minute, deploy hour), and `panel/.next.bak/` appeared untracked in the same window. 9/9 lifetime alerts on this unit are deliberate restarts.
