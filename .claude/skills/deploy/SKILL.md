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
operator's `~/.ssh/config`). **Correction:** earlier drafts of this doc
claimed the concrete host/IP was "kept out of this public repo" — that is
no longer true and should not be relied on. This repo is public, and since
the "Public access" section below was written it has carried the origin
IP, hostname, zone/account IDs, the Access app UUID, and the basic-auth
username in plain text (see "Reference values" at the end of that
section). The mitigation for that exposure is origin-side authentication —
nftables + nginx basic auth today, moving toward Cloudflare Access JWT
validation at the origin per
`docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md` — not
secrecy of the address. Steps marked **(root)** need root; run the
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
   entirely and hits nginx directly. **The converse is not true, though:**
   having the lockdown in place does *not* make Access unbypassable.
   Cloudflare's IP ranges are shared by every Cloudflare customer, so a
   request can still arrive at the origin from an allow-listed Cloudflare IP
   via *another* tenant's zone, with an Origin Rule overriding Host/SNI to
   `jamasp.mahdanian.xyz` (a documented technique — Certitude, Nov 2023).
   That request passes the firewall and matches our vhost without ever
   touching our zone's Access configuration. Basic auth (item 2 below) is
   what actually stops that path — see
   `docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md` for
   the proper origin-side fix and
   `docs/superpowers/specs/2026-08-08-panel-public-access-design.md`'s
   Architecture section for the full breakdown of what each layer does and
   doesn't guarantee.
2. **nginx** — terminates TLS (Let's Encrypt, DNS-01) and admits a request
   under `satisfy any` if **either** the Cloudflare Access JWT validates
   (via the `jamasp-authd` sidecar, below) **or** HTTP basic auth succeeds,
   before reverse-proxying to `127.0.0.1:3300`. In normal browser use the
   JWT satisfies this and no password is ever requested.
3. **Cloudflare Access** — a one-time-PIN gate on the hostname at the edge,
   in front of both of the above.

### File inventory

| File | Installed to | Purpose |
|---|---|---|
| `ops/nftables/jamasp-edge.nft` | `/etc/nftables.d/jamasp-edge.nft` | table `inet jamasp_edge`, sets `cf_v4`/`cf_v6` |
| `ops/scripts/refresh-cf-ranges.sh` | `/usr/local/sbin/refresh-cf-ranges.sh` (0755) | fetch CF ranges → nft sets + nginx real-IP snippet; fails closed, including onto an on-disk cache at boot (see C1 hardening below) |
| `ops/systemd-root/jamasp-edge.service` | `/etc/systemd/system/` | load the table at boot, `Before=nginx.service` |
| `ops/systemd-root/jamasp-cf-ranges.service` + `.timer` | `/etc/systemd/system/` | daily refresh (`OnCalendar=*-*-* 04:17:00`, `RandomizedDelaySec=30m`) — shortened from weekly post-launch |
| `ops/systemd-root/nginx.service.d/requires-jamasp-edge.conf` | `/etc/systemd/system/nginx.service.d/` | `Requires=`/`After=jamasp-edge.service` — without it, nginx starts (fail-open) even when the lockdown failed to load, since `Before=` alone is ordering, not a dependency |
| `ops/nginx/jamasp-panel.conf` | `/etc/nginx/sites-available/`, symlinked into `sites-enabled/` | public vhost + catch-all `444` default servers; `satisfy any` over `auth_request` + `auth_basic` |
| `ops/systemd/jamasp-authd.service` | `/etc/systemd/system/` **via the ordinary step-5 loop** (it must run as `jamasp`, so it belongs in `ops/systemd/`, not `-root/`) | the Access JWT sidecar on `127.0.0.1:3301` |
| `panel/next.config.ts` | built into the panel | `experimental.serverActions.allowedOrigins: ["jamasp.mahdanian.xyz"]` — without this, pages render fine but every Server Action POST silently fails Origin checking |

### The Access JWT sidecar (`jamasp-authd`)

`jamasp authd` validates the `Cf-Access-Jwt-Assertion` header that Cloudflare
attaches to every proxied request, so an Access-authenticated browser reaches
the panel without a second password prompt. Basic auth stays as the fallback
— it is what closes the tenant-spoofing hole in item 1 above.

Install:

```bash
# state dir must exist and be owned by jamasp BEFORE first start
ssh jamasp 'install -d -o jamasp -g jamasp -m 0755 /home/jamasp/.local/state/jamasp'
# then the ordinary step-5 loop, or for this unit alone:
ssh jamasp 'sed -e "s|%h|/home/jamasp|g" -e "/^\[Service\]/a User=jamasp" \
  /home/jamasp/Jamasp/ops/systemd/jamasp-authd.service \
  > /etc/systemd/system/jamasp-authd.service'
ssh jamasp 'systemctl daemon-reload && systemctl enable --now jamasp-authd'
```

Two values must be in `~/.config/jamasp/env`, and the daemon **refuses to
start** without them:

```
JAMASP_ACCESS_AUD=<the Access application's AUD tag>
JAMASP_ACCESS_TEAM_DOMAIN=mahdanian-saman-81.cloudflareaccess.com
```

Refusing to start is deliberate. An empty AUD would skip the check that pins
a token to *this* application, and the daemon would accept a validly-signed
Access token from *any* Cloudflare team. Loud failure beats silent
acceptance. (Handy cross-check: the AUD appears as `kid=` in the 302 redirect
from `curl -sSI https://jamasp.mahdanian.xyz/`.)

The JWKS is cached in memory for an hour and mirrored to
`~/.local/state/jamasp/access-jwks.json`. That file is a last-known-good
backstop, not a speed cache: it is what lets the daemon restart during a
Cloudflare outage with working keys instead of starting blind. A failed
refresh keeps the previous keys and logs a warning; it never empties them.

> **Trap: the `error_page 500 502 503 504 = @access_denied` mapping in the
> `/_access-check` location is load-bearing.** nginx's `satisfy any` treats
> only 401 and 403 as "this handler denied, try the next one". Any 5xx —
> which is exactly what a refused, hung, or dead `jamasp-authd` produces —
> finalises the request instead, skipping basic auth entirely. Without that
> mapping, "the sidecar is down" becomes a hard 500 for everyone *including*
> someone typing the correct password, which is the lockout the fallback
> exists to prevent. Do not drop it when tidying the config. The short
> `proxy_connect_timeout`/`proxy_read_timeout` are part of the same
> guarantee: they stop a hung sidecar stalling every page load for 60s.

Verify it, from the host over loopback (`iif lo accept` lets these through
the lockdown, and hitting the origin directly takes Cloudflare out of the
path so the origin's own decision is what you observe):

```bash
R="--resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/"
ssh jamasp "curl -sS -o /dev/null -w 'no-creds:%{http_code}\n' $R"   # expect 401
# Restart in the SAME invocation so a dropped connection can't leave it stopped:
ssh jamasp "systemctl stop jamasp-authd
  curl -sS -o /dev/null -w 'authd-down:%{http_code}\n' $R            # expect 401, NOT 500
  curl -sSI $R | grep -i www-authenticate                            # expect the Basic challenge
  systemctl start jamasp-authd"
```

Measured on 2026-08-09: stopped → 401; SIGSTOP-hung → 401 in 2.04s.

| Symptom | Likely cause | Check |
|---|---|---|
| Password prompt where there was none | sidecar down, or JWKS stale | `systemctl status jamasp-authd`, `journalctl -u jamasp-authd` |
| Hard 500 instead of a prompt | `error_page` mapping lost from the check location | `grep -A2 access_denied /etc/nginx/sites-available/jamasp-panel.conf` |
| Sidecar won't start | env vars missing | `grep -c JAMASP_ACCESS ~/.config/jamasp/env` (expect 2) |
| Every request 403 at the sidecar | AUD mismatch after recreating the Access app | compare `JAMASP_ACCESS_AUD` with the `kid=` in the 302 redirect |
| Panel reachable with no auth at all | both checks wrongly passing | `curl -I` from the host; expect 401, never 200 |

A note on testing it by hand: a token like `eyJ...fQ.e30.x` is rejected
*before* the key lookup, because `x` is not valid base64 — so it proves
nothing about JWKS or signature checking and leaves no log line. Use a
structurally valid RS256 token with an unknown `kid` if you want to exercise
the fetch path.

### Hardening (post-launch branch review, C1/M2)

`jamasp-edge.nft` recreates its sets **empty** on every load (a
`table`/`delete table` pair, used to make reloads idempotent), and
`jamasp-edge.service` runs that reload immediately before
`refresh-cf-ranges.sh` on every boot. That means the original "fails closed
onto the previous ranges" claim was false specifically at boot — there was
no previous live ruleset to fall back to, so one transient fetch failure at
boot (Cloudflare blip, DNS not warm, the 20s `curl` timeout) could leave
`cf_v4`/`cf_v6` empty, which drops **all** inbound 80/443 — including
Cloudflare's — until the timer's next fire.

Two changes close this:

- `refresh-cf-ranges.sh` now caches the accepted lists to
  `/var/lib/jamasp/cf-ranges.v4` and `.v6` on every success, and on any
  failure (fetch error, an absolute-floor violation, or a **relative**
  violation — fewer CIDRs than are currently loaded, catching a fetch that
  clears the floor but still silently drops real ranges) it loads that
  cache into the live nftables sets before still exiting non-zero, so the
  failure stays visible in `systemctl status` / `journalctl`.

  **Known deadlock in the relative check.** If Cloudflare ever *legitimately*
  shrinks its published list (still above the absolute floors, but below
  what is currently loaded), the relative check rejects every fetch from
  then on — permanently. The current count is read from the live set, which
  only the daily `jamasp-cf-ranges.service` touches, and that never reloads
  the table. It fails toward safety (stale ranges, not empty ones) but it
  fails **silently**, and with no `OnFailure=` wired up nothing will say so.
  Recovery is `systemctl restart jamasp-edge` — which reloads the table,
  resetting the current count to zero so the next fetch is accepted. If a
  refresh failure ever persists across days, check this before anything
  else.
- `nginx.service.d/requires-jamasp-edge.conf` (table above) stops nginx
  from starting fail-open if `jamasp-edge.service` itself fails outright
  (e.g. a syntax error in the `.nft` file — the cache can't help there
  since the table never loads). **Recovery:** fix the problem, then
  `systemctl start jamasp-edge nginx`.

### Trap: `ops/systemd-root/` is NOT `ops/systemd/`

Deliberately a separate directory. Step 5's install loop above globs
`ops/systemd/jamasp-*` and injects `User=jamasp` into every unit it copies.
`jamasp-edge.service`, `jamasp-cf-ranges.service`, and
`jamasp-cf-ranges.timer` need root (they own `/etc/nftables.d/` and the
`nft` binary) and must **never** go through that loop. Install them
directly instead — along with the two non-unit files those units depend on
(`jamasp-edge.service`'s `ExecStart` fails on a missing file otherwise, and
this is easy to drop since it's not itself a unit):

```bash
ssh jamasp 'install -d /etc/nftables.d'
ssh jamasp 'cat > /etc/nftables.d/jamasp-edge.nft' < ops/nftables/jamasp-edge.nft
ssh jamasp 'cat > /usr/local/sbin/refresh-cf-ranges.sh && chmod 0755 /usr/local/sbin/refresh-cf-ranges.sh' < ops/scripts/refresh-cf-ranges.sh

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
ssh jamasp 'install -D -m 0600 -o root -g root /dev/null /etc/letsencrypt/cloudflare.ini && cat > /etc/letsencrypt/cloudflare.ini' <<'EOF'
dns_cloudflare_api_token = PASTE_TOKEN_HERE
EOF
```
(`-D` creates `/etc/letsencrypt/` if it doesn't exist yet — on a rebuilt
host it won't, since certbot isn't installed until step 2 of the reinstall
sequence below, and plain `install` without `-D` does not create parent
directories.)

Same rule for the basic-auth file generated below — `/etc/nginx/jamasp.htpasswd`
and `/etc/letsencrypt/cloudflare.ini` never enter this repo.

### Reinstall on a rebuilt host, in order

1. **nftables lockdown first**, before anything listens on 80/443 — run
   *all* the commands in the `ops/systemd-root/` trap above: the
   `/etc/nftables.d/` directory, the `.nft` file, the refresh script, and
   the three root units, in that order. Confirm the sets are populated
   before moving on:
   `ssh jamasp 'nft list set inet jamasp_edge cf_v4 | grep -c /'` — a count
   of 0 means the lockdown would drop Cloudflare itself; stop and fix the
   fetch before continuing.
2. **nginx + certbot**:
   ```bash
   ssh jamasp 'apt-get update -qq && apt-get install -y nginx certbot python3-certbot-dns-cloudflare apache2-utils'
   ```
   Install the certbot IPv4-only drop-in now, as **commands**, not just as
   illustrative content in the trap below — without the `daemon-reload` the
   drop-in is inert and the first unattended renewal fails with Cloudflare
   error 9109 (see the certbot trap below for why it's needed):
   ```bash
   ssh jamasp 'mkdir -p /etc/systemd/system/certbot.service.d'
   ssh jamasp 'cat > /etc/systemd/system/certbot.service.d/ipv4-only.conf' <<'EOF'
   [Service]
   RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK
   EOF
   ssh jamasp 'systemctl daemon-reload'
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
   distro `default`. Generate basic-auth credentials — **capture the
   password into a variable and echo it**; the hash is bcrypt and the
   plaintext is not recoverable from it, so this is the only chance to save
   it (a bare `$(...)` substitution with nothing capturing the output, as an
   earlier draft of this doc had, discards it and locks the operator out):
   ```bash
   ssh jamasp 'PW=$(openssl rand -base64 18); htpasswd -bcB /etc/nginx/jamasp.htpasswd desk "$PW" >/dev/null 2>&1; chmod 0640 /etc/nginx/jamasp.htpasswd; chgrp www-data /etc/nginx/jamasp.htpasswd; echo "PANEL PASSWORD (save now, not recoverable): $PW"'
   ```
   Save that password immediately (password manager). Then `nginx -t`.

   Install the nginx dependency drop-in (M2 — without it, `Before=` on the
   jamasp-edge side is pure ordering, and nginx starts fail-open even when
   the lockdown failed to load):
   ```bash
   ssh jamasp 'mkdir -p /etc/systemd/system/nginx.service.d'
   ssh jamasp 'cat > /etc/systemd/system/nginx.service.d/requires-jamasp-edge.conf' < ops/systemd-root/nginx.service.d/requires-jamasp-edge.conf
   ssh jamasp 'systemctl daemon-reload'
   ```
   `systemctl enable --now nginx`, then **re-run the range refresh**:
   ```bash
   ssh jamasp '/usr/local/sbin/refresh-cf-ranges.sh && test -s /etc/nginx/conf.d/cloudflare-real-ip.conf && echo OK'
   ```
   This step is easy to skip because it looks redundant with step 1, but
   it isn't: `refresh-cf-ranges.sh` only writes
   `/etc/nginx/conf.d/cloudflare-real-ip.conf` when nginx is already
   installed (`command -v nginx`), and step 1 ran the script before nginx
   existed. Skip this and a rebuilt host silently has no real-IP
   restoration — access logs show Cloudflare edge IPs instead of real
   clients, with no error to notice.
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
keeps them incrementing under normal operation). Counters that stay at zero
for a while under normal operation are worth investigating — either nothing
is probing 80/443, or the rules aren't matching what you think they are.

**M4:** counters reset to zero on every table reload, including every boot
— `jamasp-edge.nft` starts with a `table`/`delete table` pair (for
idempotent reloads), which discards them along with the sets they're
attached to. So "counters at zero" immediately after a reboot or a manual
`nft -f` reload is normal and not, by itself, evidence anything is wrong;
give it a few minutes of normal internet background noise before treating
zero as a symptom.

**M3:** `jamasp-edge.service`'s `ExecStop` runs `nft delete table inet
jamasp_edge` — so `systemctl stop jamasp-edge` removes the *entire*
lockdown, sets and rules both. There is no "pause and keep the rules" verb.

Because nginx now carries `Requires=jamasp-edge.service`, systemd stops
nginx too when this unit is explicitly stopped, so the outcome is an
outage rather than an unfiltered origin. That is the safer failure, but do
not rely on it as a security control — it holds for an explicit `stop`, and
reasoning about every systemd path that could drop the table while nginx
survives is not worth betting the perimeter on. Treat `stop`/`restart` here
as "the lockdown is gone until I put it back", and follow promptly with
`systemctl start jamasp-edge nginx` (the `nginx.service.d` drop-in above
also requires it before nginx itself
can (re)start).

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

### Resolved: per-hostname strict TLS (I5)

**Update — this is now resolved**, superseding the "not created" status
this section previously recorded. A Cloudflare Configuration Rule on the
`http_config_settings` ruleset phase was created: ruleset
`12e2ffdb18684db7ad23462af27480b8`, rule `b7126bdae59c4f33be8a0624e98d26fb`,
`action_parameters.ssl: "strict"`, scoped to `http.host eq
"jamasp.mahdanian.xyz"`. The zone-wide setting was re-confirmed still
`full` (`modified_on: null`), so `dashagh.mahdanian.xyz` and anything else
on the zone is untouched.

Why this matters, not just that it's done: under `full`, Cloudflare
encrypts edge→origin but does **not validate the origin certificate** — an
expired, self-signed, or wrong-hostname cert on the origin would go
unnoticed, since Cloudflare accepts it regardless. `strict` (scoped to this
hostname only) makes Cloudflare actually check the origin cert against
`jamasp.mahdanian.xyz`, so a cert problem surfaces as a Cloudflare-side
error instead of silently degrading to unauthenticated TLS.

### Known gap: no failure alerting (I5)

Neither the range-refresh units (`jamasp-cf-ranges.service`/`.timer`) nor
the packaged `certbot.service` have an `OnFailure=` unit configured. A
failure in either (with no cache to fall back to for the former, or a
renewal miss for the latter) is currently only visible by *going looking*
— `systemctl status`, `journalctl`, or noticing the panel is down. Jamasp
already has a working Telegram notifier (`uv run jamasp notify`); that's
the natural hook for an `OnFailure=` unit that posts a one-line alert. This
is a **documented follow-up, not built as part of this change** — scope
here was the cache fallback and the nginx dependency, not new alerting
infrastructure.

### Known host drift (M8)

As of this writing, two on-host checkouts are not simply "at main":

- `/home/jamasp/Jamasp` is on branch `live`, and has a hand-installed
  `next.config.ts` that is **byte-identical** to the one committed to this
  branch but which git still reports as modified (likely a line-ending or
  mtime artifact from how it was placed on the host rather than checked
  out). A post-merge `git pull` there will refuse with "local changes would
  be overwritten" until that's reconciled — `git diff` will show no
  content difference, which is the tell that this is the drift, not a real
  divergence.
- `/root/Jamasp` is a stale second checkout, left over from before the
  service user was set up, carrying the **old** (pre-panel-public-access)
  `next.config.ts`. It is not what's running the panel and should not be
  assumed current for anything — treat `/home/jamasp/Jamasp` as the only
  live checkout.

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
