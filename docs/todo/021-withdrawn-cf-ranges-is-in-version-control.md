---
id: 021
title: jamasp-cf-ranges runs on the host but exists nowhere in ops/systemd
status: withdrawn
opened: 2026-09-13
owner: unassigned
closed: 2026-09-20
---

## Problem

The production host runs `jamasp-cf-ranges.service` and its timer. Neither
file exists in `ops/systemd/`, or anywhere else in this repository.

Found while checking host state before the `jamasp translate` deploy:

```
$ ssh jamasp 'systemctl list-timers --all --no-pager | grep jamasp'
jamasp-brief.service       jamasp-ingest.service    jamasp-scan.service
jamasp-cf-ranges.service   jamasp-retro.service     jamasp-watchdog.service
jamasp-dispatch.service    jamasp-flash-rollup.service  jamasp-weights.service
```

Eight of those nine have a source file under `ops/systemd/`. `cf-ranges` does
not. It is presumed to refresh Cloudflare's published IP ranges for the
panel's origin allow-list — the `access-whitelist` and public-access work is
the only thing in the system that would need them — but that is inference
from the name, not something the repository records.

## Why it matters

The `deploy` skill claims to stand up a host from scratch. It cannot: a new
host built by following it would silently lack this unit, and whatever
depends on those refreshed ranges would degrade at whatever pace Cloudflare
rotates them. The failure would appear long after the deploy, and nothing in
the runbook would point at the cause.

It also means CLAUDE.md's timer count has been wrong for longer than the
`translate` work: the Deployment section said eight while the host ran nine,
and after `translate` lands it says nine while the host runs ten. Anyone
reconciling the two will conclude one of them is stale and have no way to
tell which.

## What to do

Recover the unit and timer off the host (`systemctl cat jamasp-cf-ranges.service`
and `.timer`), commit them under `ops/systemd/` alongside the rest, add them
to the `deploy` skill's file inventory and enable loop, and correct the timer
count in CLAUDE.md's Deployment section to match reality.

If the unit turns out to be obsolete, delete it from the host instead and say
so here — either outcome closes this, but leaving it undocumented does not.

## Withdrawn — the premise was wrong

`jamasp-cf-ranges.service` and `.timer` **are** in version control, at
`ops/systemd-root/`. They live there rather than in `ops/systemd/` because the
two directories mean different things: `ops/systemd/` holds units that run as
the `jamasp` service user, `ops/systemd-root/` holds units that run as root.
`cf-ranges` rewrites nftables sets and an nginx snippet, so it is a root unit.
The `deploy` skill's own file inventory lists both of them.

This item was filed after checking `ops/systemd/` alone and concluding from its
absence there that the unit was unversioned. That was a search of one directory
presented as a search of the repository.

The one real observation underneath it survives and is worth keeping: a reader
reconciling CLAUDE.md's timer count against `systemctl list-timers` will still
come up one short, because CLAUDE.md's Deployment section counts only the
service-user timers and never mentions the root ones. That is a documentation
clarity question, not a missing-unit question, and it does not need its own
todo — a sentence in CLAUDE.md naming the two directories would close it.
