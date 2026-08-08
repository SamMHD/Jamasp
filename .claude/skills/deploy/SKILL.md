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
printf 'JAMASP_TG_TOKEN=\nJAMASP_TG_CHAT=\n' > ~/.config/jamasp/env
chmod 600 ~/.config/jamasp/env
```

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
2. **Telegram**: create a bot via @BotFather, get token + chat id, put them
   in `~/.config/jamasp/env`. Verify:
   `set -a && . ~/.config/jamasp/env && set +a && uv run jamasp notify "test"`.

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
   or `tailscale serve 3300`. The panel is still bound to localhost with
   no auth of its own — public access is provided by the nginx + Access +
   nftables stack in "Public access" below, and the SSH tunnel remains
   the fallback.
7. Rebuild after every `git pull` that touches `panel/`:
   `npm ci && npm run build && systemctl --user restart jamasp-panel`
   for user units, or (drop `--user` for system units)
   `systemctl restart jamasp-panel` for the system variant.

## Public access (jamasp.mahdanian.xyz)

The panel is also reachable publicly, behind three independent layers, none
of which restructure `panel/` — it's still the same `next start` on
`127.0.0.1:3300`:

1. **nftables lockdown** — ports 80/443 on the origin (`167.235.150.246`)
   accept traffic only from Cloudflare's published IP ranges. Without this,
   Access is decoration: anyone who finds the origin IP skips the edge
   entirely and hits nginx directly.
2. **nginx** — terminates TLS (Let's Encrypt, DNS-01) and challenges with
   HTTP basic auth before reverse-proxying to `127.0.0.1:3300`.
3. **Cloudflare Access** — a one-time-PIN gate on the hostname at the edge,
   in front of both of the above.

### File inventory

| File | Installed to | Purpose |
|---|---|---|
| `ops/nftables/jamasp-edge.nft` | `/etc/nftables.d/jamasp-edge.nft` | table `inet jamasp_edge`, sets `cf_v4`/`cf_v6` |
| `ops/scripts/refresh-cf-ranges.sh` | `/usr/local/sbin/refresh-cf-ranges.sh` (0755) | fetch CF ranges → nft sets + nginx real-IP snippet; fails closed |
| `ops/systemd-root/jamasp-edge.service` | `/etc/systemd/system/` | load the table at boot, `Before=nginx.service` |
| `ops/systemd-root/jamasp-cf-ranges.service` + `.timer` | `/etc/systemd/system/` | weekly refresh (`OnCalendar=Mon 04:17`, `RandomizedDelaySec=30m`) |
| `ops/nginx/jamasp-panel.conf` | `/etc/nginx/sites-available/`, symlinked into `sites-enabled/` | public vhost + catch-all `444` default servers |
| `panel/next.config.ts` | built into the panel | `experimental.serverActions.allowedOrigins: ["jamasp.mahdanian.xyz"]` — without this, pages render fine but every Server Action POST silently fails Origin checking |

### Trap: `ops/systemd-root/` is NOT `ops/systemd/`

Deliberately a separate directory. Step 5's install loop above globs
`ops/systemd/jamasp-*` and injects `User=jamasp` into every unit it copies.
`jamasp-edge.service`, `jamasp-cf-ranges.service`, and
`jamasp-cf-ranges.timer` need root (they own `/etc/nftables.d/` and the
`nft` binary) and must **never** go through that loop. Install them
directly instead:

```bash
for u in jamasp-edge.service jamasp-cf-ranges.service jamasp-cf-ranges.timer; do
  ssh jamasp "cat > /etc/systemd/system/$u" < "ops/systemd-root/$u"
done
ssh jamasp 'systemctl daemon-reload && systemctl enable --now jamasp-edge.service jamasp-cf-ranges.timer'
```

### Prerequisite: Cloudflare API token

DNS-01 issuance needs a token scoped **Zone:DNS:Edit + Zone:Zone:Read** on
`mahdanian.xyz` (Cloudflare cannot mint tokens via the API/MCP — create it
by hand in the dashboard). Install it on the host, never in the repo:

```bash
ssh jamasp 'install -m 0600 -o root -g root /dev/null /etc/letsencrypt/cloudflare.ini && cat > /etc/letsencrypt/cloudflare.ini' <<'EOF'
dns_cloudflare_api_token = PASTE_TOKEN_HERE
EOF
```

Same rule for the basic-auth file generated below — `/etc/nginx/jamasp.htpasswd`
and `/etc/letsencrypt/cloudflare.ini` never enter this repo.

### Reinstall on a rebuilt host, in order

1. **nftables lockdown first**, before anything listens on 80/443 (see the
   `ops/systemd-root/` trap above for the install commands). Confirm the
   sets are populated before moving on:
   `ssh jamasp 'nft list set inet jamasp_edge cf_v4 | grep -c /'` — a count
   of 0 means the lockdown would drop Cloudflare itself; stop and fix the
   fetch before continuing.
2. **nginx + certbot**:
   ```bash
   ssh jamasp 'apt-get update -qq && apt-get install -y nginx certbot python3-certbot-dns-cloudflare apache2-utils'
   ```
   Issue the certificate **inside the IPv4-only sandbox** (see the certbot
   trap below — do not run this bare):
   ```bash
   ssh jamasp 'systemd-run --wait --pipe --collect \
     -p RestrictAddressFamilies="AF_INET AF_UNIX AF_NETLINK" \
     certbot certonly --dns-cloudflare \
       --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
       --dns-cloudflare-propagation-seconds 20 \
       -d jamasp.mahdanian.xyz --non-interactive --agree-tos \
       -m saman@mahdanian.xyz --deploy-hook "systemctl reload nginx"'
   ```
   Then install `ops/nginx/jamasp-panel.conf` to
   `/etc/nginx/sites-available/`, symlink into `sites-enabled/`, remove the
   distro `default`, generate basic-auth credentials
   (`htpasswd -bcB /etc/nginx/jamasp.htpasswd desk "$(openssl rand -base64 18)"`,
   then `chmod 0640` + `chgrp www-data`), `nginx -t`, then
   `systemctl enable --now nginx`.
3. **Panel** — `panel/next.config.ts` already carries
   `serverActions.allowedOrigins`; build and enable it as in the Panel
   section above.
4. **Cloudflare Access before DNS** (ordering trap below) — create the
   self-hosted app + allow policy on `jamasp.mahdanian.xyz`.
5. **DNS last** — proxied A record `jamasp` → `167.235.150.246`.

### Trap: certbot's IPv4-only workaround

The Cloudflare API token is IP-allowlisted to the host's IPv4 address only;
the host is dual-stack and certbot's HTTP client defaults to IPv6, so the
Cloudflare zone lookup fails with error 9109 ("Cannot use the access token
from location: ..."). Fix: a systemd drop-in scoped to `certbot.service`
only — deliberately not a host-wide `/etc/gai.conf` change — at
`/etc/systemd/system/certbot.service.d/ipv4-only.conf`:

```ini
[Service]
RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK
```

This is a **workaround, not a fix** — remove the drop-in once the host's
IPv6 address is added to the token's Client IP Address Filtering allowlist
on Cloudflare's side.

**Verification trap**: a bare `certbot renew --dry-run` run in an
interactive shell is not reliable proof it will renew unattended — the
shell is unsandboxed, so it can reach the Cloudflare API over a different
network path than `certbot.timer` → `certbot.service` (with the drop-in
above) actually uses, and can report success even when the real
timer-driven renewal would fail. Verify inside the identical sandbox
instead:

```bash
ssh jamasp 'systemd-run --wait --pipe --collect -p RestrictAddressFamilies="AF_INET AF_UNIX AF_NETLINK" certbot renew --dry-run'
```

Only a dry run executed this way is evidence the automated path works.

### Trap: configure Access before creating the DNS record

Create the DNS record **last**, after nginx, certbot, and Access are all
already live. Creating DNS first — with only basic auth in front — would
leave the hostname publicly reachable through basic auth alone until Access
is added, a real exposure window during a rebuild. Access applications are
matched by hostname and don't require the DNS record to exist, so ordering
Access before DNS closes that window entirely (verified: creating the
Access app for `jamasp.mahdanian.xyz` succeeded with no DNS record present
and no warning).

### Debugging: nftables drop counters

Both drop rules in `jamasp-edge.nft` carry `counter` — this is the entry
point for checking the lockdown is actually working, not just installed:

```bash
ssh jamasp 'nft list table inet jamasp_edge'
```

Non-zero, growing counters on the `cf_v4`/`cf_v6` drop rules confirm real
non-Cloudflare traffic is being dropped (background internet scan noise
keeps them incrementing under normal operation). Counters stuck at zero are
themselves worth investigating — either nothing is probing 80/443, or the
rules aren't matching what you think they are.

### Rollback

```bash
ssh jamasp 'systemctl stop nginx'
ssh -f -N -L 3300:127.0.0.1:3300 jamasp
curl -s http://127.0.0.1:3300/ | grep -c "Last ingest"   # panel still reachable via the tunnel
ssh jamasp 'systemctl start nginx && systemctl is-active nginx'
```

The nftables lockdown and Cloudflare Access are independent of nginx —
stopping nginx only removes the origin's HTTP(S) listener. The SSH tunnel
bypasses all three layers by design: loopback traffic is exempted by
`iif lo accept` in the nftables table.

### Outstanding: per-hostname strict TLS not applied

The plan called for a Cloudflare Configuration Rule scoping `ssl: strict`
to `jamasp.mahdanian.xyz` alone, leaving the zone-wide setting at `full`.
**Not created** — the deployment's API token lacks the `rulesets`
permission (`GET .../rulesets/phases/http_config_settings/entrypoint` →
403, code 10000, "Authentication error"). This is a **token permissions
gap, not a Free-plan limitation** — the API never said Configuration Rules
are unavailable on this plan. The zone-wide SSL setting was deliberately
left untouched (no PUT was attempted) and is presumed still `full`, though
the read-back to reconfirm that also 403s under the same token. Needs
either a broader token (Zone Settings + Rulesets edit) or the Cloudflare
MCP reconnected, then:

```js
async () => cloudflare.request({
  method: "PUT",
  path: "/zones/4f4fa848a174bf69d638b66d4e6fa29b/rulesets/phases/http_config_settings/entrypoint",
  body: {
    name: "default", kind: "zone", phase: "http_config_settings",
    rules: [{
      action: "set_config",
      action_parameters: { ssl: "strict" },
      expression: '(http.host eq "jamasp.mahdanian.xyz")',
      description: "Full (strict) TLS for the Jamasp panel only",
      enabled: true,
    }],
  },
})
```

### Reference values

- Hostname `jamasp.mahdanian.xyz`, origin `167.235.150.246`, zone
  `mahdanian.xyz` (zone id `4f4fa848a174bf69d638b66d4e6fa29b`, account id
  `85799051dc45ac9a2add4892d13f4e58`).
- Access app `d9e0dc1d-797c-4f73-8915-caa3214a6d3a`, auth domain
  `mahdanian-saman-81.cloudflareaccess.com`, one-time-PIN, allow policy for
  `saman@mahdanian.xyz` and `mahdanian.saman@gmail.com`.
- Basic auth user `desk` — the password lives in the operator's password
  manager and `/etc/nginx/jamasp.htpasswd` (bcrypt) only, never in this
  repo.
