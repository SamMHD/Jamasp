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

## Addendum, 2026-08-31: the signal existed and was drowned

Checked after the credentials were renewed, and it reframes this item.

`jamasp-watchdog` **did** catch the outage, on its own, with an actionable
message — and it was the only thing that named a real consequence:

```
Aug 29 05:00:02  OK
Aug 30 05:00:02  VIOLATION: yesterday's brief missing: reports/2026/08/2026-08-29-brief.md
Aug 31 05:00:02  VIOLATION: yesterday's brief missing: reports/2026/08/2026-08-30-brief.md
```

(The one-day lag is by design — `watchdog.check` asserts on *yesterday's*
brief — so firing first on 08-30 for the 08-29 brief is correct, not late.)

So the alerting layer was not broken and this is not a missing-check problem.
Two precise daily violations were emitted into the same Telegram channel as
27 contentless `exit=1` scan alerts, at a ratio of roughly 13 to 1, and the
useful ones were not distinguishable from the noise.

That sharpens the fix. Attaching the cause to a failure alert (above) is worth
doing on its own, but the operative defect is **repetition without escalation**:
a unit that has failed 27 consecutive times should not keep sending the same
message at the same volume. Worth considering alongside the output capture:

- suppress or coalesce a repeat failure of the same unit with the same cause
  (`.claude/skills/alerting/SKILL.md` already documents a one-hour suppression
  window — check why it did not apply across a 2-hourly timer, since that
  cadence sits just outside it);
- state the streak when it does send (`scan has now failed 27 consecutive
  runs since 2026-08-28T05:00`), because a streak is the thing that makes a
  transient failure and a 3-day outage look different at a glance;
- keep watchdog violations visually distinct from per-unit failure alerts —
  they carry a different kind of information and one should not be able to
  bury the other.

Neither of these was the original framing of this item, and both are cheaper
than they look. The output capture stays the first step, because a first alert
that says "OAuth session expired and could not be refreshed" ends the incident
in minutes regardless of what else is true about volume.

## Addendum, 2026-08-31: recovery verified

For the record, and so the next reader knows what a healthy state looks like
after this failure mode. Following `claude` login as the service user:

- `claude -p --dangerously-skip-permissions "reply with exactly: OK"` → `OK`
- credentials refreshed: `expiresAt` 2026-08-31T18:05:25Z (~8h),
  `refreshTokenExpiresAt` 2026-09-28T18:47:12Z (~28d)
- `jamasp ingest` → `60 ledes, 0 source errors` (both were failing every tick)
- `jamasp flash` within that run → `5 posted, 17 scored, 0 errors`
- `systemctl start jamasp-scan.service` → `scan: ok`, exit 0
- `item_scores` writing again (last `2026-08-31T10:13:29Z`), 17 in the 24h
  window; the panel's fundamental map went from its empty state to
  `15 scored stories` (15 after the by-URL collapse `getScoredItems` applies).

**The 28-day refresh-token lifetime is now the recurrence clock.** It expired
once at `2026-08-27T23:07:02Z` despite the box invoking `claude` every two
hours, so frequent use did not extend it. On that evidence this recurs around
2026-09-28 unless something renews it first, and nothing on the host currently
watches for it. A cheap `watchdog.check` addition — read
`~/.claude/.credentials.json`'s `refreshTokenExpiresAt` and violate at, say,
under 3 days remaining — would turn a 3-day outage into a warning with days of
slack. That is arguably a better first fix than anything above, and is not yet
filed separately.

## Update, 2026-08-31: the credential check shipped

The third suggestion in the addendum above is built and deployed —
`watchdog.check` now reads `~/.claude/.credentials.json` and violates when the
OAuth refresh token has expired or expires within `CREDENTIALS_WARN_DAYS` (3).
Verified against the host's real credentials file: silent today, warns from
2026-09-25, reports `EXPIRED` after 2026-09-28.

That closes the *warning* gap — this failure mode should now announce itself
three days early instead of surfacing as a wall of contentless alerts.

**This item stays open.** It was never only about credentials, and the two
harder halves are untouched:

1. a failure alert still cannot say *why* the run failed, for any cause, because
   `_execute_once` discards the child's output (the original **Problem** above);
2. 27 consecutive identical failures still send 27 identical messages, which is
   what buried the watchdog's own precise violations at roughly 13 to 1.

The credential check helps only with the one cause it knows about. A quota
exhaustion, a `PATH` change, or a malformed prompt would still produce the same
undiagnosable `exit=1` wall it did in August.
