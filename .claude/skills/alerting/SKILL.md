---
name: alerting
description: Jamasp's systemd failure alerting — how a failed unit reaches the desk Telegram. Use when adding alerting to a new unit, diagnosing an alert that never arrived or arrived with an empty log section, tuning the suppression window, or making sense of an alert that landed in the desk chat.
---

# Failure alerting

A unit dying is never silent. Every `jamasp-*` unit, plus a drop-in for
`certbot.service`, carries `OnFailure=jamasp-alert@%n.service`. That template
runs `jamasp alert <unit>`, which puts the unit's state and last 15 journal
lines into the desk Telegram chat.

```
unit fails
  → systemd fires OnFailure=jamasp-alert@<unit>.service
    → jamasp-alert@.service  (User=jamasp, SupplementaryGroups=systemd-journal)
      → jamasp alert <unit>
        → gather()   systemctl show + journalctl -n 15
        → should_send()  suppressed if this unit alerted < 1h ago
        → compose()  Persian lead line + English technical body
        → Telegram desk chat
```

This is the ops counterpart to the **watchdog**, and the two do not overlap.
The watchdog asks "is the analyst still producing?" once a day from data
freshness (ingest heartbeat, yesterday's brief, stuck wakeups). This asks "did
a unit just fail?" the moment systemd notices. Neither covers the other's
ground — don't collapse them.

## Where things live

| Path | What |
|---|---|
| `jamasp/alert.py` | `gather()`, `compose()`, `should_send()` |
| `jamasp/cli.py` | the `jamasp alert UNIT [--dry-run]` command |
| `ops/systemd/jamasp-alert@.service` | the template unit |
| `ops/systemd-root/certbot.service.d/onfailure.conf` | drop-in; certbot ships its own unit |
| `tests/test_alert.py` | 16 tests |

Covered units: `jamasp-authd`, `jamasp-panel`, `jamasp-ingest`,
`jamasp-dispatch`, `jamasp-brief`, `jamasp-scan`, `jamasp-retro`,
`jamasp-watchdog`, `jamasp-edge`, `jamasp-cf-ranges`, `certbot`.

Constants worth knowing: `ALERT_WINDOW_MINUTES = 60`, `JOURNAL_LINES = 15`,
`MAX_MESSAGE_CHARS = 3500` (Telegram hard-rejects over 4096).

## Adding alerting to a new unit

One line in the `[Unit]` section:

```ini
OnFailure=jamasp-alert@%n.service
```

Then reinstall the unit and `systemctl daemon-reload`. For a unit you don't
own (a distro package), use a drop-in instead — see the certbot file above as
the pattern.

Then **test it by making it fail**, using the recipe below. Do not add the
line and assume.

## The four traps

### 1. `SupplementaryGroups=systemd-journal` is load-bearing

The `jamasp` user is not in that group, and `journalctl -u <another unit>`
**does not fail** for a user outside it — it prints the literal
`-- No entries --` on stdout and exits 0. The hint explaining why goes to
stderr, which the alerter does not capture.

Drop the line from `jamasp-alert@.service` and every alert still sends, still
exits 0, and carries a log section that reads as *"the unit failed quietly"*
rather than *"we cannot see its logs"*.

`gather()` normalises that marker to an empty string and `compose()` then
takes an explicit branch naming `SupplementaryGroups` as the likely cause.
Both halves are needed: the marker is truthy, so without the normalisation the
explicit branch never runs. This was a live bug — the guard was written
against an empty string that `journalctl` never actually returns.

If you see the "no journal lines available" block in a real alert, check group
membership first:

```bash
ssh jamasp 'systemctl show -p SupplementaryGroups jamasp-alert@test.service'
```

### 2. `%i`, never `%I`

`%I` unescapes `-` to `/`, which mangles every unit name here —
`jamasp-authd.service` becomes `jamasp/authd.service`.

### 3. The doubled `.service` suffix is correct

`OnFailure=jamasp-alert@%n.service` resolves to
`jamasp-alert@jamasp-authd.service.service`. That is not a typo: `%n` is the
full unit name *including* `.service`, and the trailing `.service` is the
alerter's own type suffix.

Write it with only one and `%i` silently loses the suffix — the alert names
`jamasp-authd` instead of `jamasp-authd.service`, and because the suppression
key is the unit string, the two spellings are tracked as different units.

Check what it actually resolved to:

```bash
ssh jamasp 'systemctl show -p OnFailure jamasp-authd.service'
# expect: OnFailure=jamasp-alert@jamasp-authd.service.service
```

### 4. Suppression is per unit, for an hour

`jamasp-dispatch` fires every 5 minutes. Without a window, a persistent
failure sends ~288 messages a day — and an alert channel that storms is one
people mute, which is worse than no alerting.

`should_send()` keys on `meta['alert_last.<unit>']`. It is per unit so a noisy
unit cannot mask a quiet one, and it **fails open** on an unparseable stored
timestamp, because a duplicate alert costs less than a missing one.

To change the window, edit `ALERT_WINDOW_MINUTES` in `jamasp/alert.py` — and
update `test_window_is_an_hour`, which pins it deliberately.

## Testing it

Always by injecting a real failure, never by reading the config. Use a
throwaway unit so production is untouched:

```bash
ssh jamasp 'systemd-run --unit=alert-selftest.service \
  -p OnFailure=jamasp-alert@alert-selftest.service.service \
  /bin/sh -c "echo SELFTEST: deliberate failure; exit 7"
sleep 12
journalctl -u "jamasp-alert@alert-selftest.service.service" -n 10 --no-pager
systemctl reset-failed alert-selftest.service'
```

Expect `alerted for alert-selftest.service`, a Telegram message, and a log
section containing the `SELFTEST` line — that last part is what proves journal
reading works.

**Confirm delivery from `notify_log`, not from the exit code alone.** `ok=0`
means Telegram refused it:

```bash
ssh jamasp 'su - jamasp -c "cd ~/Jamasp && uv run python -c \"
import sqlite3; c=sqlite3.connect(\\\"state/jamasp.db\\\")
for ts,ok,t in c.execute(\\\"SELECT ts,ok,text FROM notify_log ORDER BY ts DESC LIMIT 3\\\"):
    print(ts, \\\"ok=\\\"+str(ok), t.splitlines()[0])\""'
```

`--dry-run` prints the message and sends nothing:

```bash
ssh jamasp 'su - jamasp -c "cd ~/Jamasp && uv run jamasp alert nginx.service --dry-run"'
```

## Diagnosing

| Symptom | Likely cause | Check |
|---|---|---|
| No alert at all for a unit that failed | `OnFailure=` missing, or unit file not reinstalled after editing | `systemctl show -p OnFailure <unit>` |
| Alert arrived, log section empty | `SupplementaryGroups=systemd-journal` missing, or the unit genuinely logged nothing | trap 1 above |
| `notify_log.ok = 0` | `JAMASP_TG_TOKEN` / `JAMASP_TG_CHAT` not reaching the process | `systemctl show -p EnvironmentFiles jamasp-alert@test.service` |
| Alert names the wrong unit | single `.service` in `OnFailure=` | trap 3 above |
| Expected alert never came, but an earlier one did | inside the 1h suppression window | `meta` table, key `alert_last.<unit>` |
| `jamasp-alert@…` itself in `systemctl --failed` | delivery failed | `journalctl -u "jamasp-alert@<unit>.service.service"` |

**Running `jamasp alert` by hand from a plain shell logs `ok=0`.** The
Telegram env vars come from the unit's `EnvironmentFile=`, not from your login
shell. That is a testing artifact, not a fault — reproduce through systemd if
you need a faithful result:

```bash
ssh jamasp 'systemctl start "jamasp-alert@nginx.service.service"'
```

## Deliberate design decisions — don't "fix" these

**`jamasp-alert@.service` has no `OnFailure=` of its own.** An alerter that
alerts about its own failure loops. It exits non-zero on a failed send
instead, so a broken alerter lands in `systemctl --failed`.

**`jamasp alert` does not use `runner._notify_safe`.** That helper swallows
Telegram failures so an analyst run can survive a hiccup — right for a brief,
wrong here, where delivery *is* the job. The command logs to `notify_log` and
then exits non-zero.

**The body is English under a Persian lead line**, against the usual
Persian-for-Telegram rule. Unit names, systemd states and log lines are
English strings; translating the frame around them makes them harder to act on
at 3am, not easier. Same precedent as urgent `/scan` alerts appending English.

## Known blind spot

Nothing actively pages when the *alerter* fails. It surfaces in
`systemctl --failed` and in `notify_log.ok`, but if Telegram credentials
expired, the first sign would be an alert that never arrives — which is
exactly the class of failure this system exists to catch.

Closing it properly needs an external dead-man's switch: something off-host
expecting a periodic heartbeat and complaining when it stops. That is a
separate piece of work and is not built.
