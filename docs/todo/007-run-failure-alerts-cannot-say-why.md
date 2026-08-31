---
id: 007
title: Agent-run failure alerts carry no reason, because run_agent discards claude's output
status: open
opened: 2026-08-31
owner: unassigned
closed:
---

## Problem

`jamasp/runner.py#_execute_once` routes both of `claude`'s streams to
`subprocess.DEVNULL`. When a run fails, `run_agent` therefore has nothing to
report but the exit code, and the Telegram alert reads:

```
Jamasp FAILURE: scan run failed after retry, exit=1.
```

That message is the same whether Claude is logged out, out of quota, missing
from `PATH`, or crashing on a bad prompt. The operator cannot tell which
without SSHing to the host and re-running the command by hand.

## Why it matters

This already cost 3½ days of a fully dark agent half, on 2026-08-28 through
2026-08-31.

The host's OAuth **refresh token** expired at `2026-08-27T23:07:02Z`
(`claudeAiOauth.refreshTokenExpiresAt` in `~/.claude/.credentials.json`).
Every Claude-dependent path failed from the next refresh attempt onward. The
desk received 27+ identical `exit=1` alerts over that window and no way to act
on them; the actual cause took one manual command to find, and would have been
in the first alert if the output had been kept:

```
Failed to authenticate: OAuth session expired and could not be refreshed
```

The blast radius was much wider than the alerts suggested, because only three
of the affected paths alert at all:

| Path | Alerts? | Observed damage |
|---|---|---|
| scan | yes | 28 failed runs |
| brief | yes | 3 failed runs — no morning brief |
| retro | yes | the 2026-08-30 weekly retro failed |
| deepdive | yes | 2 failed runs |
| digest (ledes) | **no** | 791 of 857 items in 3 days had no lede |
| flash triage | **no** | news channel silent; `item_scores` stopped at `2026-08-28T04:02:12Z`, which emptied the fundamental map |

The two silent ones only surface in `source_errors`, which nothing watches.

## Evidence

Checked on the host 2026-08-31, all confirmed by running the thing:

- `systemctl show jamasp-scan.service -p Result` → `exit-code`, `ExecMainStatus=1`;
  each run takes ~3s wall for both attempts, far inside the 300s timeout.
- `journalctl -u jamasp-scan.service` carries only `scan: failed` — no cause,
  because of the `DEVNULL` above (`jamasp/runner.py`, `_execute_once`).
- Running the wrapped command directly as the service user:
  `claude -p --dangerously-skip-permissions "reply with OK"` →
  `Failed to authenticate: OAuth session expired and could not be refreshed`.
- `~/.claude/.credentials.json`: mode `0600`, mtime `2026-08-28T04:30:46Z`,
  `refreshTokenExpiresAt` = `2026-08-27T23:07:02Z`, `expiresAt` = `0`,
  `subscriptionType` = `max`. (Only expiry metadata was read; no token
  material was printed.)
- `agent_runs`: last `ok` per type — scan `2026-08-27T19:00`, brief
  `2026-08-28T03:30`, deepdive `2026-08-26T13:15`, retro `2026-08-23T16:00`.
  First scan failure after the last success: `2026-08-28T05:00`.
- `source_errors` for `digest` and `flash` recur every ingest tick with
  `Command '['claude', '-p', '--model', ...]'` prefixes.

Negative results worth not re-checking:

- This is **not** the daily run cap: cap deferrals record `status='deferred'`
  and post a different message; every row here is `status='failed'`.
- This is **not** a timeout: `status='timeout'` is a distinct branch, and the
  runs exit in ~3s against a 300s budget.
- The retry inside `run_agent` is working as designed — it retries once and
  both attempts fail identically, which is why wall time is ~3s not ~1.5s.

## Fix

Capture a bounded tail of the child's output and put it in the alert.

`_execute_once` currently uses `DEVNULL` deliberately — its docstring records
that `subprocess.run(timeout=...)` could hang forever in `communicate()`
waiting on pipes inherited by `claude`'s own grandchildren, which is a real
bug and must not be reintroduced. So the fix is **not** to switch to
`capture_output=True`.

Instead: redirect both streams to a `tempfile.NamedTemporaryFile`, keep the
existing `Popen` + `start_new_session` + `killpg` timeout path exactly as it
is, and on failure read back the last ~500 characters. A file has no pipe
buffer to fill and no reader to block on, so the hang the docstring describes
cannot occur.

Then include that tail in the failure notice, trimmed to fit a Telegram
message, and make sure it also lands in the journal so `journalctl` alone is
enough next time.

Consider separately whether `digest` and `flash` should alert at all — today
their failures reach only `source_errors`, and both were dark for 3½ days with
no notification. That may be a second todo rather than part of this one.

## Done when

- A run whose `claude` invocation fails produces a Telegram alert containing
  the reason, verified by forcing a real failure (e.g. pointing `claude_cmd`
  at a command that exits non-zero with a known message on stderr) and reading
  the alert text.
- The same reason appears in `journalctl -u jamasp-scan.service`.
- `tests/test_runner.py` covers: output captured on failure, output not
  captured on success, and — the one that matters — a child that spawns a
  grandchild holding the output handle open still gets killed at the timeout
  rather than hanging, so the regression the `DEVNULL` docstring warns about
  is pinned by a test rather than by a comment.

## Related

- `jamasp/runner.py` — `_execute_once`, `run_agent`.
- `.claude/skills/deploy/SKILL.md` — "Human handoff" step 1 is the recovery
  procedure for the expiry that exposed this; constraint 2 covers the
  credentials file.
- `.claude/skills/alerting/SKILL.md` — the alert delivery layer, which worked
  correctly throughout; this item is about the message content, not delivery.
