---
id: 207
title: The daily DB snapshots live on the same disk as the DB — losing the host loses every copy
status: open
opened: 2026-11-17
owner: unassigned
closed:
---

## Problem

`state/jamasp.db` left git in Nov 2026: its committed copies had grown `.git`
to 9 GB and the post-commit repack OOM-killed scans and briefs (todo 205 on
`live`). Its safety net is now `jamasp backup` (daily, `jamasp-backup.timer`),
which writes gzipped snapshots to `~/backups/jamasp-db/` on the host itself.
Nothing copies them anywhere else.

## Why it matters

Until the cutover, GitHub's `live` branch held a copy of every committed DB.
That was an off-box copy, even if an expensive one. Now a lost disk, a
deleted VM or a botched rebuild takes the DB *and* all 14 snapshots with it:
every item, score, prediction, flash record and bar the panel and the retros
read. Reports and state files still reach GitHub through the daily push.

## Evidence

- Snapshot size measured on the host 2026-11-04: `VACUUM INTO` 0.48 s,
  57.8 MB raw, **17.1 MB** gzipped. 14 copies come to ~240 MB.
- Host disk on 2026-11-04: 75 GB, 45% used.
- Negatives, checked on the host 2026-11-04: there is no `rclone`, `restic`,
  `aws` or `b2` binary, and no rclone config for root or `jamasp`. Any sync
  tool would be a new install.
- Unknown: whether Hetzner's server-level Backups are enabled for this VM.
  Only the Hetzner console shows that. Not checked.

## Fix

Pick one:

1. **Hetzner Backups** (no code): turn on Backups for the server in the
   Hetzner console. That's 7 daily whole-disk images kept off the VM's disk,
   for +20% of the server price. Restores are whole-server, which is coarse
   but covers the disk-loss case.
2. **Object storage sync**: an `ExecStartPost=` on `jamasp-backup.service`
   that copies the newest snapshot to Cloudflare R2 (the account already
   fronts the panel) or a Hetzner Storage Box. This needs a credential in
   `~/.config/jamasp/env` and a retention rule on the bucket.

## Done when

A snapshot made by the timer exists somewhere other than the host, and a
restore from that copy has been tried once: download it, `gunzip`, open it,
`PRAGMA quick_check` = `ok`.

## Related

- `jamasp/backup.py`, `ops/systemd/jamasp-backup.{service,timer}`.
- Deploy skill, **Backups** section.
- Plan `docs/superpowers/plans/2026-11-04-db-out-of-git.md`.
