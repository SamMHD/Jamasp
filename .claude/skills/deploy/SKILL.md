---
name: deploy
description: Deploy or redeploy Jamasp to a Linux host — install runtime, clone, set up systemd timers for ingest + daily brief, and hand off the human auth steps. Use when setting up Jamasp on a new server or repairing an existing deployment.
---

# Deploying Jamasp to a host

Jamasp runs on an always-on Linux box: deterministic `jamasp` CLI on a
timer for ingestion, and a scheduled headless Claude Code run for the daily
brief. This skill is the full runbook, including the two gotchas that will
bite you if you skip them.

## Non-negotiable constraints (learned the hard way)

1. **The brief must NOT run as root.** Claude Code refuses
   `--dangerously-skip-permissions` under root/sudo ("cannot be used with
   root/sudo privileges for security reasons"), and the autonomous brief
   needs that flag to run bash/edit/git without prompts. **Always run the
   agent as a dedicated non-root user** (e.g. `jamasp`). If the box only
   gives you root, create the user (below).
2. **Claude credentials are file-based and portable** — `~/.claude/.credentials.json`.
   You can carry a login between users by copying that file, but **copy the
   file, not the directory**: `claude`'s installer already created
   `~/.claude/`, so `cp -a /root/.claude ~otheruser/.claude` nests it to
   `~/.claude/.claude/`. Copy `.credentials.json` directly into the existing
   `~/.claude/`.
3. **Secrets never live in the repo.** Telegram token/chat id go in
   `~/.config/jamasp/env` (chmod 600), referenced by the units via
   `EnvironmentFile=`.

## Steps

Run everything as the target service user (`jamasp`) unless noted. Assumes
Ubuntu/systemd; the repo is PUBLIC so no GitHub auth is needed to clone.

### 1. (root only) create the service user
```bash
id jamasp || useradd -m -s /bin/bash jamasp
```

### 2. install runtime (as the service user)
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh          # -> ~/.local/bin/uv
curl -fsSL https://claude.ai/install.sh | bash           # -> ~/.local/bin/claude
```

### 3. clone + sync + identity
```bash
git clone https://github.com/SamMHD/Jamasp.git ~/Jamasp
cd ~/Jamasp && git checkout phase1-mvp        # use main once PR #1 is merged
~/.local/bin/uv sync
git config user.name Jamasp
git config user.email jamasp@mahdanian.xyz    # for the per-run commits
```

### 4. secrets scaffold
```bash
mkdir -p ~/.config/jamasp
printf 'JAMASP_TG_TOKEN=\nJAMASP_TG_CHAT=\n' > ~/.config/jamasp/env
chmod 600 ~/.config/jamasp/env
```

### 5. systemd units
Use **system** units (`/etc/systemd/system/`, `User=jamasp`) when you have
root; use **user** units (`~/.config/systemd/user/`, plus
`loginctl enable-linger jamasp` and `XDG_RUNTIME_DIR=/run/user/$(id -u)`)
when you only have the unprivileged account.

`jamasp-ingest.service` (Type=oneshot) → `ExecStart=%h/.local/bin/uv run jamasp ingest`
paired with `jamasp-ingest.timer` → `OnCalendar=*:0/15`, `Persistent=true`,
`RandomizedDelaySec=90`.

`jamasp-brief.service` (Type=oneshot) →
`ExecStart=%h/.local/bin/claude -p "/brief" --dangerously-skip-permissions`
paired with `jamasp-brief.timer` → `OnCalendar=*-*-* 07:30:00 Asia/Dubai`
(systemd ≥252 honors the timezone suffix; the box clock stays UTC).

Both services set `Environment=PATH=<home>/.local/bin:/usr/local/bin:/usr/bin:/bin`,
`Environment=HOME=<home>`, and `EnvironmentFile=-<home>/.config/jamasp/env`.

Then: `daemon-reload`, `enable --now jamasp-ingest.timer`. Leave the brief
timer **disabled** until the human steps below are done.

### 6. verify the deterministic half now
```bash
cd ~/Jamasp
uv run jamasp sources check      # every source should print OK
uv run jamasp ingest             # 0 ledes until Claude is logged in — expected
uv run jamasp price
systemctl start jamasp-ingest.service && systemctl show jamasp-ingest.service -p Result
```

## Human handoff (two steps, then activate)

1. **Log Claude in** as the service user: `claude`, complete the login with
   the dedicated Max account. This enables the Haiku digest (ingest ledes)
   AND the brief. Verify: `claude -p "hi" --dangerously-skip-permissions`.
2. **Telegram**: create a bot via @BotFather, get token + chat id, put them
   in `~/.config/jamasp/env`. Verify:
   `set -a && . ~/.config/jamasp/env && set +a && uv run jamasp notify "test"`.

Then run one **supervised brief** (`claude`, type `/brief`) or
`systemctl start jamasp-brief.service`; confirm a report appeared under
`reports/`, a commit was made, and the Telegram summary arrived. When happy:
```bash
systemctl enable --now jamasp-brief.timer
```

## Sanity / ops
```bash
systemctl list-timers | grep jamasp
journalctl -u jamasp-ingest.service -n 20
journalctl -u jamasp-brief.service -n 40
```
A transient inbox `WARNING` about source `digest` just means Claude isn't
logged in yet; it clears on the first successful digest. The box commits
state locally each run but can't push to GitHub without a write credential —
add a deploy key if you want the history mirrored.
