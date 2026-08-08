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
4. **Cloudflare WARP: PROXY MODE ONLY — never full tunnel.** Full-tunnel
   WARP (`warp-cli mode warp`) hijacks the default route on connect; on a
   remote-managed box the return path breaks and you lose SSH entirely
   (this happened — recovery needed provider console access). Proxy mode
   only opens a localhost SOCKS5 port and never touches routing. The
   sequence in "7. egress proxy" below sets the mode **before** the first
   connect and verifies it; keep that order. If `warp-cli settings` ever
   shows a Mode other than `WarpProxy`, disconnect before anything else.

## Steps

Assumes Ubuntu/systemd; the repo is PUBLIC so no GitHub auth is needed to
clone.

### 0. Access the host
Everything below runs **on the target host**, reached over SSH. The current
production deployment is reachable as `ssh jamasp` (an alias in the
operator's `~/.ssh/config`; the concrete host/IP is kept out of this public
repo — see private ops notes). Steps marked **(root)** need root; run the
rest as the service user, e.g. `sudo -u jamasp -i` (or log in as `jamasp`).
Over SSH, prefix a service-user command as:
```bash
ssh jamasp 'sudo -u jamasp -i bash -lc "cd ~/Jamasp && uv run jamasp price"'
```

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
printf 'JAMASP_TG_TOKEN=\nJAMASP_TG_CHAT=\nJAMASP_TG_NEWS_CHAT=\n' > ~/.config/jamasp/env
chmod 600 ~/.config/jamasp/env
```

`JAMASP_TG_NEWS_CHAT` is the channel that receives per-story gold news
flashes. Create a second Telegram channel, add the same bot to it as an
administrator with "Post Messages" and "Edit Messages of Others" both
enabled — the flash pipeline edits its own messages when a second source
picks up a story — and put its chat id here. If the variable is missing, the
flash pass disables itself and logs to `source_errors`; ingestion, briefs, and
scans are unaffected.

### 5. systemd units
All 12 unit files (6 services + 6 timers: ingest, brief, scan, dispatch,
retro, watchdog) live in `ops/systemd/` in this repo — copy them onto the
host rather than hand-writing units. Use **system** units
(`/etc/systemd/system/`, `User=jamasp`) when you have root; use **user**
units (`~/.config/systemd/user/`, plus `loginctl enable-linger jamasp` and
`XDG_RUNTIME_DIR=/run/user/$(id -u)`) when you only have the unprivileged
account.

**System units** (root — replace `%h` with `/home/jamasp` and add `User=jamasp`
to each `[Service]` block):
```bash
for f in /home/jamasp/Jamasp/ops/systemd/jamasp-*; do
  sed -e 's|%h|/home/jamasp|g' -e '/^\[Service\]/a User=jamasp' "$f" \
    > "/etc/systemd/system/$(basename "$f")"
done
systemctl daemon-reload
```

**User units** (unprivileged account — keep `%h` as-is):
```bash
mkdir -p ~/.config/systemd/user
cp ~/Jamasp/ops/systemd/jamasp-* ~/.config/systemd/user/
loginctl enable-linger jamasp   # timers survive logout
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user daemon-reload
```

`jamasp-brief` replaces phase 1's direct `claude -p "/brief"` ExecStart —
`jamasp run brief` now wraps it (cap/retry/Telegram). The brief/scan/retro/
dispatch services rely on `claude` being on the `PATH=` set in each unit.
Timer OnCalendar values (systemd ≥252 honors the `Asia/Dubai` suffix; the
box clock stays UTC): ingest `*:0/15`, dispatch `*:0/5`, watchdog daily
`09:00`, brief daily `07:30`, scan `09,11,13,15,17,19,21,23:00` (all Dubai
time), retro `Sun 20:00` Dubai.

Enable in two stages — the deterministic infra first, the agentic runs
after the human handoff:
```bash
# (drop --user for system units)
systemctl --user enable --now jamasp-ingest.timer jamasp-dispatch.timer jamasp-watchdog.timer
# jamasp-brief.timer, jamasp-scan.timer, jamasp-retro.timer stay DISABLED
# until the human steps below are done
```

### 6. verify the deterministic half now
```bash
cd ~/Jamasp
uv run jamasp sources check      # every source should print OK
uv run jamasp ingest             # 0 ledes until Claude is logged in — expected
uv run jamasp price
systemctl start jamasp-ingest.service && systemctl show jamasp-ingest.service -p Result
```

### 7. egress proxy (WARP proxy mode — for `jamasp extract`)

Several publishers (CNBC, MarketWatch, Mining.com) 401/403 requests coming
from datacenter IPs. `jamasp extract` falls back to the proxy named in
`JAMASP_EXTRACT_PROXY`; provide it with Cloudflare WARP in **proxy mode
only** (constraint 4 — full tunnel kills SSH on a remote box). As root:

```bash
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor \
  --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
. /etc/os-release
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ ${VERSION_CODENAME} main" \
  > /etc/apt/sources.list.d/cloudflare-client.list
apt-get update -qq && apt-get install -y cloudflare-warp
systemctl enable --now warp-svc && sleep 3

warp-cli --accept-tos registration new
warp-cli --accept-tos mode proxy          # BEFORE the first connect — always
warp-cli --accept-tos proxy port 40000
warp-cli --accept-tos settings | grep "Mode:"   # must say: WarpProxy on port 40000
warp-cli --accept-tos connect
ip route show default                     # MUST be unchanged (dev eth0);
                                          # if not: warp-cli disconnect NOW
curl --proxy socks5h://127.0.0.1:40000 https://ifconfig.me   # Cloudflare IP
echo 'JAMASP_EXTRACT_PROXY=socks5://127.0.0.1:40000' >> /home/jamasp/.config/jamasp/env
```

Known limits: Investing.com still 403s (Cloudflare bot *challenge*, not IP
reputation — no plain HTTP client passes it), and Google News wrapper URLs
"succeed" but yield menu junk instead of the article; treat both as
headline-only sources.

## Human handoff (two steps, then activate)

1. **Log Claude in** as the service user: `claude`, complete the login with
   the dedicated Max account. This enables the Haiku digest (ingest ledes)
   AND the brief. Verify: `claude -p "hi" --dangerously-skip-permissions`.
2. **Telegram**: create a bot via @BotFather; you will need two channels.
   - **Desk channel** (briefs, scan alerts, failure notices): get its chat id and put the bot token + this chat id as `JAMASP_TG_TOKEN` and `JAMASP_TG_CHAT` in `~/.config/jamasp/env`. Verify: `set -a && . ~/.config/jamasp/env && set +a && uv run jamasp notify "test"`.
   - **News channel** (per-story gold news flashes): create a second channel, add the same bot as an administrator with **both** "Post Messages" and "Edit Messages of Others" enabled (the flash pipeline edits its own earlier message when a second outlet picks up the same story), get its chat id, and put it as `JAMASP_TG_NEWS_CHAT` in the same env file. If you leave this blank, the flash pass disables itself silently — ingestion, briefs, and scans are unaffected, and `uv run jamasp watchdog` will still print OK. The check that catches it is `uv run jamasp flash --dry-run`: its summary line ends with an error count, and a missing news chat shows up there as `1 errors`.

Then run one **supervised brief** (`claude`, type `/brief`) or
`systemctl start jamasp-brief.service`; confirm a report appeared under
`reports/`, a commit was made, and the Telegram summary arrived. When happy,
enable the remaining agentic timers (drop `--user` for system units):
```bash
systemctl --user enable --now jamasp-brief.timer jamasp-scan.timer jamasp-retro.timer
```

**Watchdog check**: after the first full day, confirm `uv run jamasp watchdog`
prints OK — that means ingest/dispatch/brief/scan all ran on schedule.

## Sanity / ops
```bash
systemctl list-timers | grep jamasp
journalctl -u jamasp-ingest.service -n 20
journalctl -u jamasp-dispatch.service -n 20
journalctl -u jamasp-watchdog.service -n 20
journalctl -u jamasp-brief.service -n 40
journalctl -u jamasp-scan.service -n 40
journalctl -u jamasp-retro.service -n 40
```
A transient inbox `WARNING` about source `digest` just means Claude isn't
logged in yet; it clears on the first successful digest. The box commits
state locally each run but can't push to GitHub without a write credential —
add a deploy key if you want the history mirrored.

## Panel (optional web control panel)

The panel is a Next.js app in `panel/`, served on `127.0.0.1:3300` by
`jamasp-panel.service` (a long-running service — enable it, unlike the
oneshot timer units).

1. Install Node >= 20 (NodeSource apt repo or the distro package).
2. Build: `cd ~/Jamasp/panel && npm ci && npm run build`.
3. Apply the DB schema before first boot: `cd ~/Jamasp && uv run jamasp wakeup list`.
   This is required, not redundant — `notify_log` (and other panel-read
   tables) are created by the shared `_common` DB-open helper the first time
   *any* `jamasp` CLI command runs; on a host that predates the panel, no
   such command has run yet, so without this step `/` and `/alerts` serve
   errors until the next scheduled ingest tick happens to create the table.
   `wakeup list` is read-only, so it's safe to run against a live DB.
4. Install/enable the unit the same way as the timers (the
   `ops/systemd/jamasp-*` glob already includes it), then:
   `systemctl --user enable --now jamasp-panel.service` for user units, or
   for the system variant (`User=jamasp`), drop `--user`:
   `systemctl enable --now jamasp-panel.service`.
5. Verify: `curl -s http://127.0.0.1:3300/ | grep -q "Last ingest" && echo OK`.
   Grepping for "Overview" is not a real check — that's the sidebar nav
   link, present even when the page body has failed; "Last ingest" only
   appears once the Overview's stat cards actually render.
6. Access from a workstation: `ssh -L 3300:127.0.0.1:3300 jamasp@<host>`
   or `tailscale serve 3300`. The panel has NO auth of its own — never
   bind it to a public interface.
7. Rebuild after every `git pull` that touches `panel/`:
   `npm ci && npm run build && systemctl --user restart jamasp-panel`
   for user units, or (drop `--user` for system units)
   `systemctl restart jamasp-panel` for the system variant.
