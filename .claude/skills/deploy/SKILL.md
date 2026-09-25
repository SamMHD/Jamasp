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
All 18 unit files (9 services + 9 timers: ingest, brief, scan, dispatch,
retro, watchdog, flash-rollup, weights, translate) live in `ops/systemd/` in
this repo — copy them onto the
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
time), retro `Sun 20:00` Dubai, weights `03:30` Dubai.

Enable in two stages — the deterministic infra first, the agentic runs
after the human handoff:
```bash
# (drop --user for system units)
systemctl --user enable --now jamasp-ingest.timer jamasp-dispatch.timer jamasp-watchdog.timer jamasp-flash-rollup.timer jamasp-weights.timer
# jamasp-brief.timer, jamasp-scan.timer, jamasp-retro.timer stay DISABLED
# until the human steps below are done
```

`jamasp-translate.timer` is the ninth, and it stays **disabled** here too —
for a different reason from the agentic three. It needs codex installed and
logged in (next section), and the design spec asks for the host's item volume
to be measured before `max_batches_per_run` is trusted: count a day of items
and how many already carry flash Persian, set the knob against the remainder,
then enable it. Until it has run once the watchdog's translate probes stay
silent, so leaving it off costs no false alerts.

```bash
uv run jamasp translate --check          # codex resolves and is authenticated
uv run jamasp translate --dry-run        # how much a first tick would face
systemctl --user enable --now jamasp-translate.timer
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

### codex: install, then credentials (for `jamasp translate`)

The translate timer shells out to `codex exec`, so codex has to **be there**
before it can be logged in. `jamasp-translate.service` hard-codes
`PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`, which is the constraint on
where it may land: install it **as the `jamasp` service user** into
`~/.local/bin`, or system-wide into `/usr/local/bin`.

```bash
su - jamasp -c 'npm install -g @openai/codex --prefix ~/.local'   # needs node
# or drop the release binary for this arch into ~/.local/bin/codex, chmod +x
su - jamasp -c 'command -v codex && codex --version'              # must print a path
```

If it resolves anywhere else (a version manager's shim, `~/.bun/bin`, a snap),
either symlink it into `~/.local/bin` or point `translate.cmd[0]` in
`config/settings.yaml` at the absolute path. A login shell finding `codex`
proves nothing about the unit: the unit does not read your profile.

Then authenticate, again **as the `jamasp` service user**, not as root:

```bash
su - jamasp -c 'codex login'
```

The credentials land in `$CODEX_HOME` — `~/.codex` by default, so
`/home/jamasp/.codex/auth.json`. Two things follow. The unit runs as `jamasp`
with `%h` = `/home/jamasp`, so a login performed as root writes
`/root/.codex/auth.json` and the timer never sees it. And if you set
`CODEX_HOME` anywhere (to keep credentials off the home directory, say), set
it in `~/.config/jamasp/env` as well — the unit reads that file and nothing
else:

```bash
echo 'CODEX_HOME=/home/jamasp/.codex' >> ~/.config/jamasp/env   # only if moved
```

Verify the whole path before enabling the timer:

```bash
su - jamasp -c 'cd ~/Jamasp && uv run jamasp translate --check'
```

Same trap as Claude's credentials: an interactive login as the wrong user
leaves the service user unauthenticated, and a `codex exec` with lapsed auth
fails every batch while still exiting zero — so the unit's `OnFailure` alert
stays silent. `--check` is what catches it; `jamasp watchdog`'s backlog probe
is what catches it later — and that probe only arms once translate has run at
least once, so on a host where the timer was never enabled it says nothing.

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
5. Verify: `curl -s http://127.0.0.1:3300/ | grep -q "errors 24h" && echo OK`.
   Grepping for "Overview" is not a real check — that's the sidebar nav
   link, present even when the page body has failed. `errors 24h` is a
   `StatusStrip` label (`panel/components/status-strip.tsx`), so it only
   appears once the Overview's status strip actually renders.
   **The old marker for this was "Last ingest"; it no longer exists** —
   the design-system work (PR #27) replaced those stat cards with the
   compact strip that reads `ingest 11m ago · runs 0/20 · errors 24h 0`.
   A check for "Last ingest" now fails on a perfectly healthy panel.
6. Access from a workstation: `ssh -L 3300:127.0.0.1:3300 jamasp@<host>`
   or `tailscale serve 3300`. The panel is still bound to localhost with
   no auth of its own — public access is provided by the nginx + Access +
   nftables stack in "Public access" below, and the SSH tunnel remains
   the fallback.
7. Rebuild after every `git pull` that touches `panel/`:
   `npm ci && npm run build && systemctl --user restart jamasp-panel`
   for user units, or (drop `--user` for system units)
   `systemctl restart jamasp-panel` for the system variant.

## Public access (jamasp.mkagent.co)

The panel's public hostname is `jamasp.mkagent.co`. `jamasp.mahdanian.xyz`
was the original hostname; it still exists, but now only as a 301 to the
one above, so old bookmarks and links already published in reports keep
working — its DNS record, nginx vhost and Access application are all
deliberately kept, not torn down. See "TLS: Cloudflare Origin CA
certificate" and "Reference values" below for both hostnames' ids.

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
   `jamasp.mkagent.co` (a documented technique — Certitude, Nov 2023) — that's
   the hostname to use for this attack now, since it's the vhost that
   actually serves the panel; overriding to `jamasp.mahdanian.xyz` only gets
   an attacker the bare redirect, nothing more.
   That request passes the firewall and matches our vhost without ever
   touching our zone's Access configuration. Basic auth (item 2 below) is
   what actually stops that path — see
   `docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md` for
   the proper origin-side fix and
   `docs/superpowers/specs/2026-08-08-panel-public-access-design.md`'s
   Architecture section for the full breakdown of what each layer does and
   doesn't guarantee.
2. **nginx** — terminates TLS (a Cloudflare Origin CA certificate — see "TLS:
   Cloudflare Origin CA certificate" below, not Let's Encrypt any more) and
   admits a request under `satisfy any` if **either** the Cloudflare Access
   JWT validates (via the `jamasp-authd` sidecar, below) **or** HTTP basic
   auth succeeds, before reverse-proxying to `127.0.0.1:3300`. In normal
   browser use the JWT satisfies this and no password is ever requested.
3. **Cloudflare Access** — a one-time-PIN gate on the hostname at the edge,
   in front of both of the above. **Two Access applications exist now, one
   per hostname** — see "Reference values" below for both.

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
| `panel/next.config.ts` | built into the panel | `experimental.serverActions.allowedOrigins: ["jamasp.mkagent.co", "jamasp.mahdanian.xyz"]` — without the current hostname, pages render fine but every Server Action POST silently fails Origin checking; the legacy hostname stays listed only for the transition (a tab already open on it still POSTs from that Origin, and browsers don't reliably follow a 301 for a POST) |
| *(not in repo — issued via the Cloudflare API)* | `/etc/ssl/certs/jamasp-origin.pem` (0644, root) + `/etc/ssl/private/jamasp-origin.key` (0600, root) | Origin CA cert/key that `ops/nginx/jamasp-panel.conf`'s `ssl_certificate`/`ssl_certificate_key` point at — see "TLS: Cloudflare Origin CA certificate" below |

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

**Two Access applications exist now** — current panel (`jamasp.mkagent.co`)
and legacy redirect (`jamasp.mahdanian.xyz`); see "Reference values" below
for both ids and AUDs. `JAMASP_ACCESS_AUD` must be the **current panel**
one, not the legacy one — the sidecar only ever validates the hostname that
actually serves the panel through `auth_request`. The legacy vhost is a
bare 301 with no `auth_request` at all, so its AUD is never checked against
anything here; pointing this at the legacy AUD would make every real
request fail the check the daemon exists to perform.

Refusing to start is deliberate. An empty AUD would skip the check that pins
a token to *this* application, and the daemon would accept a validly-signed
Access token from *any* Cloudflare team. Loud failure beats silent
acceptance. (Handy cross-check: the AUD appears as `kid=` in the 302 redirect
from `curl -sSI https://jamasp.mkagent.co/`.)

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
R="--resolve jamasp.mkagent.co:443:127.0.0.1 -k https://jamasp.mkagent.co/"
ssh jamasp "curl -sS -o /dev/null -w 'no-creds:%{http_code}\n' $R"   # expect 401
# Restart in the SAME invocation so a dropped connection can't leave it stopped:
ssh jamasp "systemctl stop jamasp-authd
  curl -sS -o /dev/null -w 'authd-down:%{http_code}\n' $R            # expect 401, NOT 500
  curl -sSI $R | grep -i www-authenticate                            # expect the Basic challenge
  systemctl start jamasp-authd"
```

`-k` is required now and wasn't before this migration: `--resolve` sends this
straight to the origin, bypassing Cloudflare's edge entirely, so curl itself
validates the certificate — and the public trust store curl uses doesn't
include Cloudflare's Origin CA root. Without `-k` every one of these checks
fails on the TLS handshake before nginx's auth logic ever runs, which looks
identical to "the sidecar is broken" but means something else entirely.
Ordinary requests through Cloudflare's edge never need this: the edge
presents its own publicly-trusted certificate to the browser regardless of
what the origin holds.

Measured on 2026-08-09 (pre-migration, against the Let's Encrypt cert then in
place): stopped → 401; SIGSTOP-hung → 401 in 2.04s. The sidecar's behavior is
unaffected by the TLS change — only the flag needed to observe it from the
host changed.

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

### Failure alerting (`jamasp-alert@`)

Every `jamasp-*` unit carries `OnFailure=jamasp-alert@%n.service`, plus a
drop-in for `certbot.service`, so a failed unit reaches the desk Telegram
instead of sitting in the journal.

`ops/systemd/jamasp-alert@.service` installs through the ordinary step-5 loop.
The certbot drop-in is separate:

```bash
ssh jamasp 'mkdir -p /etc/systemd/system/certbot.service.d'
ssh jamasp 'cp /home/jamasp/Jamasp/ops/systemd-root/certbot.service.d/onfailure.conf \
  /etc/systemd/system/certbot.service.d/onfailure.conf'
ssh jamasp 'systemctl daemon-reload'
```

**Superseded by the TLS migration:** this drop-in only does anything if
`certbot.service` still runs on the host. TLS for the panel moved to a
Cloudflare Origin CA certificate (see "TLS: Cloudflare Origin CA
certificate" below), so nothing renews via certbot for this vhost any more
— on a fresh install there's no `certbot.service` for the drop-in to attach
to, and installing it is optional. On a host that predates the migration,
leaving it in place is harmless.

Verify by injecting a real failure, never by reading the config:

```bash
ssh jamasp 'systemd-run --unit=alert-selftest.service \
  -p OnFailure=jamasp-alert@alert-selftest.service.service \
  /bin/sh -c "echo SELFTEST; exit 7"
sleep 12
journalctl -u "jamasp-alert@alert-selftest.service.service" -n 10 --no-pager
systemctl reset-failed alert-selftest.service'
```

Expect `alerted for alert-selftest.service` and a Telegram message.

> **The `alerting` skill (`.claude/skills/alerting/SKILL.md`) is the
> authority on this layer** — the traps (`%i` vs `%I`, the deliberately
> doubled `.service` suffix, `SupplementaryGroups=systemd-journal`, the
> one-hour suppression window), the diagnostic table, and the design
> decisions that must not be "fixed". Read it before changing anything here.

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

### TLS: Cloudflare Origin CA certificate

TLS for this vhost is a Cloudflare **Origin CA** certificate, not Let's
Encrypt/certbot — see "Historical: certbot's IPv4-only workaround (superseded
by Origin CA)" further down for why that changed, and the header comment in
`ops/nginx/jamasp-panel.conf` for the reasoning the vhost itself carries.
There is no API token to install on the host at all for this: nftables
already restricts 80/443 to Cloudflare's ranges, so the edge proxy is the
only client that ever completes a handshake here, and Cloudflare trusts its
own Origin CA — no renewal, no timer, no token to go stale.

One certificate covers both hostnames' SAN (`jamasp.mkagent.co` and
`jamasp.mahdanian.xyz`), expires 2041-09-21, id
`188133292607190827397673185325461104624708937497` (see "Reference values").
Issue or reissue it with the Cloudflare API MCP tool (`ToolSearch` for
`select:mcp__plugin_cloudflare_cloudflare-api__execute`) — generate a CSR and
private key first (e.g. `openssl req -new -newkey rsa:2048 -nodes -keyout
jamasp-origin.key -out jamasp-origin.csr -subj "/CN=jamasp.mkagent.co"`),
then:

```js
async () => cloudflare.request({
  method: "POST",
  path: "/certificates",
  body: {
    hostnames: ["jamasp.mkagent.co", "jamasp.mahdanian.xyz"],
    request_type: "origin-rsa",
    requested_validity: 5475,
    csr: "<contents of jamasp-origin.csr>",
  },
})
```

`GET /certificates?zone_id=<a zone id containing one of the hostnames>` lists
existing ones — this endpoint is account-scoped, not per-zone, so any zone id
that touches the cert works for the lookup. Install the returned certificate
and the key you generated, never in the repo:

```bash
ssh jamasp 'install -D -m 0644 -o root -g root /dev/null /etc/ssl/certs/jamasp-origin.pem && cat > /etc/ssl/certs/jamasp-origin.pem' <<< "$CERT_PEM"
ssh jamasp 'install -D -m 0600 -o root -g root /dev/null /etc/ssl/private/jamasp-origin.key && cat > /etc/ssl/private/jamasp-origin.key' <<< "$KEY_PEM"
```
(`-D` creates the parent directory if it doesn't exist yet — on a rebuilt
host `/etc/ssl/certs/` and `/etc/ssl/private/` normally already exist as
part of the base OS, but nginx still needs both files present before it
will start; it fails closed on a missing cert rather than falling back.)

Same rule as ever for the basic-auth file generated below —
`/etc/nginx/jamasp.htpasswd` never enters this repo, and neither does the
Origin CA private key.

**A hazard specific to `mkagent.co`, not `mahdanian.xyz`:** the `mkagent.co`
zone also hosts a separate, unrelated live website (`A mkagent.co →
149.56.225.6`, plus MX/SPF for that site's email). Its zone-wide SSL/TLS mode
is `full` and has never been touched — which is exactly what Origin CA
needs, so it was left alone rather than "improved." Zone-wide settings are
not per-hostname: changing SSL/TLS mode, Always Use HTTPS, or any other
zone-level Cloudflare setting "for the panel's benefit" changes it for that
other site too. Origin CA works under `full` or `full (strict)`; it would
break under `flexible`, because this vhost's plaintext-80 handler redirects
straight to HTTPS, so a `flexible`-mode edge fetching the origin over plain
HTTP would loop against that redirect forever. If stricter per-hostname
validation is ever wanted for the panel specifically, follow the pattern in
"Resolved: per-hostname strict TLS (I5)" below — a Configuration Rule scoped
by `http.host`, not a zone-wide change.

### Reinstall on a rebuilt host, in order

1. **nftables lockdown first**, before anything listens on 80/443 — run
   *all* the commands in the `ops/systemd-root/` trap above: the
   `/etc/nftables.d/` directory, the `.nft` file, the refresh script, and
   the three root units, in that order. Confirm the sets are populated
   before moving on:
   `ssh jamasp 'nft list set inet jamasp_edge cf_v4 | grep -c /'` — a count
   of 0 means the lockdown would drop Cloudflare itself; stop and fix the
   fetch before continuing.
2. **nginx + TLS**:
   ```bash
   ssh jamasp 'apt-get update -qq && apt-get install -y nginx apache2-utils'
   ```
   TLS is a Cloudflare Origin CA certificate now, not certbot/Let's Encrypt
   — certbot is not part of a fresh install at all any more. Issue and
   install the certificate and key as in "TLS: Cloudflare Origin CA
   certificate" above **before** starting nginx: it fails closed on a
   missing cert rather than starting without TLS.

   If you land on a host that still has certbot, `/etc/letsencrypt/`, or the
   `certbot.service.d` drop-ins installed from before this migration, none
   of it governs this vhost's certificate any more — see "Historical:
   certbot's IPv4-only workaround (superseded by Origin CA)" below. Leave it
   in place or purge it; either is safe.

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
   self-hosted app + allow policy for `jamasp.mkagent.co` (the current
   panel hostname). If you're also rebuilding the legacy redirect from
   scratch, do the same for `jamasp.mahdanian.xyz` — see "Reference values"
   for both applications' ids and AUDs.
5. **DNS last** — proxied `A jamasp.mkagent.co → 167.235.150.246` in the
   `mkagent.co` zone. The legacy `jamasp.mahdanian.xyz` record already
   exists in the `mahdanian.xyz` zone and isn't part of a fresh rebuild
   unless you're recreating that hostname too.

### Historical: certbot's IPv4-only workaround (superseded by Origin CA)

**None of this governs anything any more.** TLS for this vhost moved to a
Cloudflare Origin CA certificate — see "TLS: Cloudflare Origin CA
certificate" above. This section is kept, not deleted, so that anyone who
finds `/etc/letsencrypt/` or the `certbot.service.d` drop-ins still on the
host understands what they were for and why they stopped mattering.

The Cloudflare API token used for DNS-01 issuance was IP-allowlisted to the
host's IPv4 address only; the host is dual-stack and certbot's HTTP client
defaults to IPv6, so the Cloudflare zone lookup failed with error 9109
("Cannot use the access token from location: ..."). The workaround at the
time was a systemd drop-in scoped to `certbot.service` only — deliberately
not a host-wide `/etc/gai.conf` change — at
`/etc/systemd/system/certbot.service.d/ipv4-only.conf`:

```ini
[Service]
RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK
```

This is what used to run (inside that sandbox) to issue the certificate,
for reference if an old `/etc/letsencrypt/renewal/*.conf` on the host needs
explaining:

```bash
ssh jamasp 'systemd-run --wait --pipe --collect \
  -p RestrictAddressFamilies="AF_INET AF_UNIX AF_NETLINK" \
  certbot certonly --dns-cloudflare \
    --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 20 \
    -d jamasp.mahdanian.xyz --non-interactive --agree-tos \
    -m saman@mahdanian.xyz --deploy-hook "systemctl reload nginx"'
```

This was documented as "a workaround, not a fix," and the intended real fix —
adding the host's IPv6 address to the token's Client IP Address Filtering
allowlist — never happened. **The workaround nevertheless still works.**

Be careful here, because this is where the 2026-09-25 migration got its
reasoning wrong at first. A bare `certbot renew --dry-run` in a root shell
fails with 9109, and that was briefly read as "renewal is broken, the
certificate expires 2026-11-06". It was the test that was broken: a shell does
not get the `certbot.service` drop-in, so it egresses over IPv6 and is
rejected, while `certbot.timer` → `certbot.service` runs inside
`RestrictAddressFamilies=AF_INET` and is not. Re-running the dry run inside
the same sandbox reported "all simulated renewals succeeded".

The real reason for the migration is narrower: the token is scoped to the
`mahdanian.xyz` zone alone and cannot write DNS in `mkagent.co` (verified — it
returns `Authentication error` for that zone even over IPv4), so it could not
issue for `jamasp.mkagent.co` at all. Let's Encrypt for the new hostname
needed a new token minted by hand in the dashboard. Origin CA needed no token,
covers both hostnames in one certificate, and never renews.

**Verification trap — and it runs the opposite way to the obvious guess.** A
bare `certbot renew --dry-run` in an interactive shell is not proof of
anything, because the shell is *less* restricted than the timer: it egresses
over IPv6 and **fails** with 9109, while the timer, pinned to AF_INET by the
drop-in above, **succeeds**. The shell test is a false alarm, not a false
reassurance. Reading it the wrong way round is what produced a wrong "the
certificate is about to expire" conclusion on 2026-09-25. The only trustworthy
check is the dry run inside the identical sandbox:

```bash
ssh jamasp 'systemd-run --wait --pipe --collect -p RestrictAddressFamilies="AF_INET AF_UNIX AF_NETLINK" certbot renew --dry-run'
```

This still works and `certbot.timer` is still enabled, so the Let's Encrypt
certificate for `jamasp.mahdanian.xyz` keeps renewing — deliberately, even
though nginx now serves the Origin CA certificate for both hostnames. It costs
nothing, it keeps `OnFailure=` alerting meaningful rather than firing on a
renewal nobody wants, and it is a one-line fallback: point `ssl_certificate`
back at `/etc/letsencrypt/live/jamasp.mahdanian.xyz/` if Origin CA ever has to
be backed out.

Two consequences worth holding onto. The certificate certbot renews is **not**
the certificate nginx serves, so it is the wrong thing to inspect when
debugging a TLS problem on either hostname — check
`/etc/ssl/certs/jamasp-origin.pem`. And if you ever do retire this, disable
`certbot.timer` rather than only deleting the renewal config, or the timer
fires, finds nothing to do, and the `OnFailure=` drop-in gets a chance to page
the desk about it.

### Trap: configure Access before creating the DNS record

Create the DNS record **last**, after nginx, TLS, and Access are all already
live. Creating DNS first — with only basic auth in front — would leave the
hostname publicly reachable through basic auth alone until Access is added,
a real exposure window during a rebuild. Access applications are matched by
hostname and don't require the DNS record to exist, so ordering Access
before DNS closes that window entirely (verified: creating the Access app
for `jamasp.mahdanian.xyz` succeeded with no DNS record present and no
warning — this was verified against the original hostname before the
`mkagent.co` migration, but the mechanism it relies on, hostname matching
with no DNS dependency, is unrelated to which hostname or zone is involved,
so the same ordering applies to `jamasp.mkagent.co` on a rebuild).

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

This rule lives in the `mahdanian.xyz` zone and only ever covered
`jamasp.mahdanian.xyz`; the `mkagent.co` migration didn't touch it and
doesn't need to — nothing here is stale. `jamasp.mkagent.co` is a different
hostname in a different zone (`mkagent.co`) and has no equivalent rule today;
that zone's own hazard and what Origin CA needs from it are covered in "TLS:
Cloudflare Origin CA certificate" above.

### Known gap: no failure alerting (I5)

Neither the range-refresh units (`jamasp-cf-ranges.service`/`.timer`) nor
the packaged `certbot.service` have an `OnFailure=` unit configured. A
failure in either (with no cache to fall back to for the former, or a
renewal miss for the latter — though since the move to a Cloudflare Origin
CA certificate, certbot no longer renews anything for this vhost, so that
half of the gap no longer applies to the panel's certificate specifically)
is currently only visible by *going looking* — `systemctl status`,
`journalctl`, or noticing the panel is down. Jamasp
already has a working Telegram notifier (`uv run jamasp notify`); that's
the natural hook for an `OnFailure=` unit that posts a one-line alert. This
is a **documented follow-up, not built as part of this change** — scope
here was the cache fallback and the nginx dependency, not new alerting
infrastructure.

### Known host drift (M8)

As of this writing, two on-host checkouts are not simply "at main":

- `/home/jamasp/Jamasp` is on branch `live`, which tracks `origin/live` and
  runs hundreds of commits ahead of `main` with its own per-run state
  commits. **Never `git pull` there** — the convention is
  `git merge origin/main` into `live` (verified 2026-09-05: `git status`
  stays clean apart from the expected ` M state/jamasp.db`, which every run
  rewrites and which must never be staged, stashed or reverted). The host
  has no git write credential, so nothing can be pushed back from it.
  *Resolved:* the `next.config.ts` drift this section used to warn about —
  a byte-identical file that git still reported as modified — is gone as of
  2026-09-05; `git status --porcelain panel/next.config.ts` is empty.
- `/root/Jamasp` is a stale second checkout, left over from before the
  service user was set up, carrying the **old** (pre-panel-public-access)
  `next.config.ts`. It is not what's running the panel and should not be
  assumed current for anything — treat `/home/jamasp/Jamasp` as the only
  live checkout.

### Reference values

- **Current panel hostname** `jamasp.mkagent.co`, origin `167.235.150.246`,
  zone `mkagent.co` (zone id `28374bd7669d760f298f8800735ff956`, account id
  `85799051dc45ac9a2add4892d13f4e58`). DNS: proxied `A jamasp.mkagent.co →
  167.235.150.246`.
- **Legacy redirect hostname** `jamasp.mahdanian.xyz` — 301s to the above,
  same origin, zone `mahdanian.xyz` (zone id
  `4f4fa848a174bf69d638b66d4e6fa29b`, same account id). Its DNS record,
  nginx vhost and Access application are all deliberately still live; see
  "Public access" above for why.
- **Two Access applications**, same auth domain
  `mahdanian-saman-81.cloudflareaccess.com`, one-time-PIN:

  | | application id | AUD | hostname |
  |---|---|---|---|
  | current panel | `c0dea932-2301-4102-8ebd-5949ccfa3b88` | `99a2db1163d4c718c98962a5e74c6e7c9dbf9dbb597a357c9ec9df926cb4348f` | `jamasp.mkagent.co` |
  | legacy redirect | `d9e0dc1d-797c-4f73-8915-caa3214a6d3a` | `b54e2de7426792dfaa6f9134c8c5d01b36491a72e4ed0e3c7f5ac7f812d27264` | `jamasp.mahdanian.xyz` |

  `JAMASP_ACCESS_AUD` must be the **current panel** row's AUD (see "The
  Access JWT sidecar" above for why). Each application carries one "Desk
  operators" allow policy with the same six emails — see the
  `access-whitelist` skill for the current list and how to edit it, rather
  than duplicating a list here that would drift.
- **TLS**: one Cloudflare Origin CA certificate, id
  `188133292607190827397673185325461104624708937497`, both hostnames above
  in its SAN, expires 2041-09-21. Installed at
  `/etc/ssl/certs/jamasp-origin.pem` (0644, root) and
  `/etc/ssl/private/jamasp-origin.key` (0600, root).
- Basic auth user `desk` — the password lives in the operator's password
  manager and `/etc/nginx/jamasp.htpasswd` (bcrypt) only, never in this
  repo.
