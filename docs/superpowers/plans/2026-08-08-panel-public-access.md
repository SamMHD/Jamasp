# Panel Public Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Jamasp control panel at `https://jamasp.mahdanian.xyz` behind three independent layers — Cloudflare Access, nginx basic auth, and an nftables lockdown limiting ports 80/443 to Cloudflare ranges — with Let's Encrypt certificates that renew themselves.

**Architecture:** The panel stays bound to `127.0.0.1:3300` and is not restructured. nginx on the origin terminates TLS, enforces basic auth, and reverse-proxies to it. nftables makes the origin unreachable except from Cloudflare, which is what turns Access from decoration into an actual gate. Certificates are issued over DNS-01, so no inbound port is needed for ACME and issuance works with the orange cloud on and the lockdown active.

**Tech Stack:** nginx 1.28.3, certbot 4.0.0 + `python3-certbot-dns-cloudflare`, nftables 1.1.6, systemd 259, Ubuntu 26.04, Next.js 16.2.12, Cloudflare API.

**Spec:** `docs/superpowers/specs/2026-08-08-panel-public-access-design.md`

## Global Constraints

- **A second agent is working in the same git tree** (`main`, news-flash feature, Python/ingest side). Implementation happens in an isolated worktree on branch `feat/panel-public-access`. **Never** run `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset`, or `git checkout <path>` — stage explicit paths only, and never in the shared tree.
- **Do not touch the host's git repo** (`/home/jamasp/Jamasp`). Config is installed to `/etc/` by piping file contents over SSH, not by `git pull` on the host. This keeps the deployment independent of whatever the other agent lands.
- **Do not restart `jamasp-ingest`, `jamasp-dispatch`, or any agent timer.** Only `jamasp-panel` and `nginx` may be restarted.
- Host: `ssh jamasp` reaches it as **root**. Panel unit is a **system** unit at `/etc/systemd/system/jamasp-panel.service` running `User=jamasp`.
- Exact values, copied from the spec — do not retype from memory:
  - Hostname: `jamasp.mahdanian.xyz`
  - Origin IPv4: `167.235.150.246`
  - Zone ID: `4f4fa848a174bf69d638b66d4e6fa29b`
  - Account ID: `85799051dc45ac9a2add4892d13f4e58`
  - Access auth domain: `mahdanian-saman-81.cloudflareaccess.com`
  - Access allowlist: `saman@mahdanian.xyz`, `mahdanian.saman@gmail.com`
  - Zone SSL mode stays `full`; strict is applied **per-hostname only**. `dashagh.mahdanian.xyz` must keep working.
- Secrets never enter the repo: `/etc/nginx/jamasp.htpasswd`, `/etc/letsencrypt/cloudflare.ini`.
- Every task ends with evidence — a command and its actual output. "Should work" is not a completion criterion.

## Prerequisite (blocks Task 2)

A Cloudflare API token scoped **Zone:DNS:Edit + Zone:Zone:Read on `mahdanian.xyz`**, created by hand in the dashboard. Tooling cannot mint tokens (`/user/tokens` → error 9109). Tasks 1 and 3–8 do not need it; only certificate issuance does.

## File Structure

| File | Responsibility |
|---|---|
| `ops/nftables/jamasp-edge.nft` | Scoped nftables table + empty Cloudflare sets |
| `ops/scripts/refresh-cf-ranges.sh` | Fetch CF ranges → nft sets + nginx real-IP snippet; fails closed |
| `ops/systemd-root/jamasp-edge.service` | Load the table at boot, populate it |
| `ops/systemd-root/jamasp-cf-ranges.service` | Weekly refresh job |
| `ops/systemd-root/jamasp-cf-ranges.timer` | Weekly schedule |
| `ops/nginx/jamasp-panel.conf` | Public vhost + catch-all default server |
| `panel/next.config.ts` | Declare the public origin for Server Actions |
| `.claude/skills/deploy/SKILL.md` | "Public access" runbook section |

`ops/systemd-root/` is a **new directory, deliberately not `ops/systemd/`**: the deploy skill's install loop globs `ops/systemd/jamasp-*` and injects `User=jamasp` into every unit it copies. These units need root. Keeping them in a separate directory avoids silently breaking them.

---

### Task 1: Origin lockdown (nftables + range refresh)

Ports 80/443 become reachable only from Cloudflare. Done first, before anything listens on those ports, so nginx is never briefly exposed.

**Files:**
- Create: `ops/nftables/jamasp-edge.nft`
- Create: `ops/scripts/refresh-cf-ranges.sh`
- Create: `ops/systemd-root/jamasp-edge.service`
- Create: `ops/systemd-root/jamasp-cf-ranges.service`
- Create: `ops/systemd-root/jamasp-cf-ranges.timer`

**Interfaces:**
- Produces: nftables table `inet jamasp_edge` with sets `cf_v4`/`cf_v6`; the script at `/usr/local/sbin/refresh-cf-ranges.sh`; the generated nginx snippet `/etc/nginx/conf.d/cloudflare-real-ip.conf` (consumed by Task 3).

- [ ] **Step 1: Create the isolated worktree**

Run from `/Users/saman/Rabin/Jamasp`. Use the `superpowers:using-git-worktrees` skill. Concretely:

```bash
git worktree add ../Jamasp-panel-public -b feat/panel-public-access main
cd ../Jamasp-panel-public
git status --porcelain   # expect: empty
```

All subsequent file edits happen in `../Jamasp-panel-public`. The shared tree is left alone.

- [ ] **Step 2: Record the pre-state (the test that must fail)**

From your **workstation**, not the host:

```bash
curl -sS --connect-timeout 5 -o /dev/null http://167.235.150.246/ ; echo "exit=$?"
```

Expected now: `exit=7` (connection refused — nothing listening, packets not filtered).
After this task: `exit=28` (timed out — packets dropped). Write down that you saw `7`.

- [ ] **Step 3: Write the nftables table**

Create `ops/nftables/jamasp-edge.nft`:

```
#!/usr/sbin/nft -f
# Origin lockdown for the Jamasp panel — ports 80/443 reachable only from
# Cloudflare. Deliberately a SCOPED table with `policy accept`: only traffic
# to 80/443 is ever matched, so a bad range list can never lock SSH out.
#
# The create-then-delete pair at the top makes reloading idempotent.

table inet jamasp_edge
delete table inet jamasp_edge

table inet jamasp_edge {
    set cf_v4 {
        type ipv4_addr
        flags interval
    }

    set cf_v6 {
        type ipv6_addr
        flags interval
    }

    chain input {
        type filter hook input priority filter; policy accept;

        tcp dport { 80, 443 } iif lo accept
        tcp dport { 80, 443 } meta nfproto ipv4 ip  saddr != @cf_v4 drop
        tcp dport { 80, 443 } meta nfproto ipv6 ip6 saddr != @cf_v6 drop
    }
}
```

- [ ] **Step 4: Write the range-refresh script**

Create `ops/scripts/refresh-cf-ranges.sh`:

```bash
#!/usr/bin/env bash
# Refresh the Cloudflare source ranges used by the origin lockdown (nftables
# sets) and by nginx real-IP restoration.
#
# Fails CLOSED onto the previous ranges: if the fetch looks implausible we
# exit non-zero without touching live config. An empty set would drop
# Cloudflare itself and take the panel offline; stale ranges are always the
# safer state.
set -euo pipefail

V4_URL="https://www.cloudflare.com/ips-v4"
V6_URL="https://www.cloudflare.com/ips-v6"
MIN_CIDRS=5
NFT_TABLE="inet jamasp_edge"
NGINX_SNIPPET="/etc/nginx/conf.d/cloudflare-real-ip.conf"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsS --max-time 20 "$V4_URL" -o "$tmp/v4"
curl -fsS --max-time 20 "$V6_URL" -o "$tmp/v6"

# Keep only well-formed CIDRs — guards against error pages and truncation.
grep -Ex '[0-9.]+/[0-9]+'       "$tmp/v4" > "$tmp/v4.clean" || true
grep -Ex '[0-9a-fA-F:]+/[0-9]+' "$tmp/v6" > "$tmp/v6.clean" || true

v4n="$(wc -l < "$tmp/v4.clean")"
v6n="$(wc -l < "$tmp/v6.clean")"
if [ "$v4n" -lt "$MIN_CIDRS" ] || [ "$v6n" -lt "$MIN_CIDRS" ]; then
    echo "refresh-cf-ranges: implausible list (v4=$v4n v6=$v6n) — keeping existing ranges" >&2
    exit 1
fi

# nftables: replace both sets in one atomic transaction.
{
    echo "flush set $NFT_TABLE cf_v4"
    echo "flush set $NFT_TABLE cf_v6"
    echo "add element $NFT_TABLE cf_v4 { $(paste -sd, "$tmp/v4.clean") }"
    echo "add element $NFT_TABLE cf_v6 { $(paste -sd, "$tmp/v6.clean") }"
} > "$tmp/sets.nft"
nft -f "$tmp/sets.nft"

# nginx real-IP snippet — only once nginx is actually installed.
if command -v nginx >/dev/null 2>&1 && [ -d /etc/nginx/conf.d ]; then
    {
        echo "# Generated by refresh-cf-ranges.sh — do not edit by hand."
        sed 's|^|set_real_ip_from |; s|$|;|' "$tmp/v4.clean"
        sed 's|^|set_real_ip_from |; s|$|;|' "$tmp/v6.clean"
        echo "real_ip_header CF-Connecting-IP;"
        echo "real_ip_recursive on;"
    } > "$tmp/real-ip.conf"

    if ! cmp -s "$tmp/real-ip.conf" "$NGINX_SNIPPET"; then
        install -m 0644 "$tmp/real-ip.conf" "$NGINX_SNIPPET"
        nginx -t && systemctl reload nginx
    fi
fi

echo "refresh-cf-ranges: ok (v4=$v4n v6=$v6n)"
```

Then `chmod +x ops/scripts/refresh-cf-ranges.sh`.

- [ ] **Step 5: Write the systemd units**

Create `ops/systemd-root/jamasp-edge.service`:

```ini
[Unit]
Description=Jamasp origin lockdown — restrict 80/443 to Cloudflare ranges
After=network-online.target
Wants=network-online.target
Before=nginx.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/nftables.d/jamasp-edge.nft
ExecStart=/usr/local/sbin/refresh-cf-ranges.sh
ExecStop=/usr/sbin/nft delete table inet jamasp_edge

[Install]
WantedBy=multi-user.target
```

Create `ops/systemd-root/jamasp-cf-ranges.service`:

```ini
[Unit]
Description=Refresh Cloudflare source ranges for the Jamasp origin lockdown
After=network-online.target jamasp-edge.service
Requires=jamasp-edge.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/refresh-cf-ranges.sh
```

Create `ops/systemd-root/jamasp-cf-ranges.timer`:

```ini
[Unit]
Description=Weekly refresh of Cloudflare source ranges

[Timer]
OnCalendar=Mon 04:17
Persistent=true
RandomizedDelaySec=30m

[Install]
WantedBy=timers.target
```

- [ ] **Step 6: Syntax-check the nft file on the host without applying it**

```bash
ssh jamasp 'mkdir -p /etc/nftables.d'
ssh jamasp 'cat > /etc/nftables.d/jamasp-edge.nft' < ops/nftables/jamasp-edge.nft
ssh jamasp 'nft -c -f /etc/nftables.d/jamasp-edge.nft && echo NFT_SYNTAX_OK'
```

Expected: `NFT_SYNTAX_OK`. `-c` checks only; nothing is applied yet.

- [ ] **Step 7: Install the script and units, then activate**

```bash
ssh jamasp 'cat > /usr/local/sbin/refresh-cf-ranges.sh && chmod 0755 /usr/local/sbin/refresh-cf-ranges.sh' < ops/scripts/refresh-cf-ranges.sh
for u in jamasp-edge.service jamasp-cf-ranges.service jamasp-cf-ranges.timer; do
  ssh jamasp "cat > /etc/systemd/system/$u" < "ops/systemd-root/$u"
done
ssh jamasp 'systemctl daemon-reload && systemctl enable --now jamasp-edge.service && systemctl enable --now jamasp-cf-ranges.timer'
```

- [ ] **Step 8: Verify the sets are populated**

```bash
ssh jamasp 'nft list set inet jamasp_edge cf_v4 | head -20; echo "---"; nft list set inet jamasp_edge cf_v4 | grep -o "[0-9]\+\.[0-9]\+\.[0-9]\+\.[0-9]\+/[0-9]\+" | wc -l'
```

Expected: roughly 15 IPv4 CIDRs including `173.245.48.0/20` and `104.16.0.0/13`.
**If the count is 0, stop** — the lockdown would be blocking Cloudflare too.

- [ ] **Step 9: Verify the drop actually happens (the test now passes)**

From your **workstation**:

```bash
curl -sS --connect-timeout 5 -o /dev/null http://167.235.150.246/ ; echo "exit=$?"
ssh jamasp 'echo SSH_STILL_WORKS'
```

Expected: `exit=28` (timeout — was `7` in Step 2) and `SSH_STILL_WORKS`.

- [ ] **Step 10: Verify it survives a systemd reload and is enabled at boot**

```bash
ssh jamasp 'systemctl is-enabled jamasp-edge.service jamasp-cf-ranges.timer; systemctl list-timers jamasp-cf-ranges.timer --no-pager | head -3'
```

Expected: `enabled` twice, and a scheduled next-run line for the timer.

- [ ] **Step 11: Commit (explicit paths only)**

```bash
git add ops/nftables/jamasp-edge.nft ops/scripts/refresh-cf-ranges.sh ops/systemd-root/
git commit -m "ops: restrict origin ports 80/443 to Cloudflare ranges"
```

---

### Task 2: Certificate issuance and automatic renewal

DNS-01 issuance. Needs the API token from the Prerequisite section. nginx is installed here (still unreachable publicly thanks to Task 1) so certbot's deploy hook has something to reload.

**Files:** none in the repo — host-side only.

**Interfaces:**
- Consumes: the nftables lockdown from Task 1.
- Produces: `/etc/letsencrypt/live/jamasp.mahdanian.xyz/{fullchain,privkey}.pem`, consumed by Task 3.

- [ ] **Step 1: Install packages**

```bash
ssh jamasp 'apt-get update -qq && apt-get install -y nginx certbot python3-certbot-dns-cloudflare apache2-utils'
ssh jamasp 'nginx -v; certbot --version'
```

Expected: nginx 1.28.3, certbot 4.0.0.

- [ ] **Step 2: Install the API token credentials file**

Ask the operator for the token. Do not echo it into shell history or logs:

```bash
ssh jamasp 'install -m 0600 -o root -g root /dev/null /etc/letsencrypt/cloudflare.ini && cat > /etc/letsencrypt/cloudflare.ini' <<'EOF'
dns_cloudflare_api_token = PASTE_TOKEN_HERE
EOF
ssh jamasp 'stat -c "%a %U:%G" /etc/letsencrypt/cloudflare.ini'
```

Expected: `600 root:root`. Certbot warns loudly if it is not.

- [ ] **Step 3: Confirm the certificate does not exist yet**

```bash
ssh jamasp 'ls /etc/letsencrypt/live/jamasp.mahdanian.xyz/ 2>&1'
```

Expected: "No such file or directory".

- [ ] **Step 4: Issue the certificate**

```bash
ssh jamasp 'certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 20 \
  -d jamasp.mahdanian.xyz \
  --non-interactive --agree-tos -m saman@mahdanian.xyz \
  --deploy-hook "systemctl reload nginx"'
```

- [ ] **Step 5: Verify the certificate exists and is trusted**

```bash
ssh jamasp 'certbot certificates'
ssh jamasp 'openssl x509 -in /etc/letsencrypt/live/jamasp.mahdanian.xyz/fullchain.pem -noout -subject -issuer -enddate'
```

Expected: subject CN `jamasp.mahdanian.xyz`, issuer Let's Encrypt, ~90 days out.

- [ ] **Step 6: Prove renewal is automatic — do not wait 60 days**

```bash
ssh jamasp 'systemctl list-timers certbot.timer --no-pager'
ssh jamasp 'grep -A2 renew_hook /etc/letsencrypt/renewal/jamasp.mahdanian.xyz.conf'
ssh jamasp 'certbot renew --dry-run'
```

Expected: `certbot.timer` active with a next-run time; `renew_hook = systemctl reload nginx` present; dry run reports success for the domain.
**If `certbot.timer` is absent**, the deb did not ship it — create an equivalent timer before calling this task done.

---

### Task 3: nginx vhost with basic auth

**Files:**
- Create: `ops/nginx/jamasp-panel.conf`

**Interfaces:**
- Consumes: certificate paths from Task 2; `/etc/nginx/conf.d/cloudflare-real-ip.conf` from Task 1's script.
- Produces: TLS + basic-auth-protected proxy to `127.0.0.1:3300`.

Note: no `Upgrade`/`Connection` proxy headers. The panel is served by `next start` and polls with SWR — it opens no WebSockets, and adding the headers would pull in an `http`-context `map` for no benefit.

- [ ] **Step 1: Write the vhost**

Create `ops/nginx/jamasp-panel.conf`:

```nginx
# Jamasp panel — public vhost.
# Install to /etc/nginx/sites-available/jamasp-panel.conf, symlink into
# sites-enabled. Real client IPs are restored by the generated snippet
# /etc/nginx/conf.d/cloudflare-real-ip.conf (see refresh-cf-ranges.sh),
# which nginx picks up from conf.d automatically.

# Anything that arrives without a hostname we recognise gets nothing at all.
server {
    listen      80  default_server;
    listen      [::]:80 default_server;
    server_name _;
    return 444;
}

server {
    listen      443 ssl default_server;
    listen      [::]:443 ssl default_server;
    server_name _;

    ssl_certificate     /etc/letsencrypt/live/jamasp.mahdanian.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/jamasp.mahdanian.xyz/privkey.pem;

    return 444;
}

server {
    listen      80;
    listen      [::]:80;
    server_name jamasp.mahdanian.xyz;
    return 301 https://$host$request_uri;
}

server {
    listen      443 ssl;
    listen      [::]:443 ssl;
    http2       on;
    server_name jamasp.mahdanian.xyz;

    ssl_certificate     /etc/letsencrypt/live/jamasp.mahdanian.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/jamasp.mahdanian.xyz/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options    "nosniff" always;
    add_header X-Frame-Options           "DENY"    always;

    auth_basic           "Jamasp";
    auth_basic_user_file /etc/nginx/jamasp.htpasswd;

    client_max_body_size 2m;

    access_log /var/log/nginx/jamasp-panel.access.log;
    error_log  /var/log/nginx/jamasp-panel.error.log;

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;

        # Next.js Server Actions compare Origin against the forwarded host.
        # Get these wrong and every page renders while every button fails.
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

        proxy_read_timeout 120s;
    }
}
```

- [ ] **Step 2: Generate the basic-auth credentials**

Username `desk`, with a generated password — do not invent one by hand:

```bash
ssh jamasp 'PW=$(openssl rand -base64 18); htpasswd -bcB /etc/nginx/jamasp.htpasswd desk "$PW" >/dev/null 2>&1; chmod 0640 /etc/nginx/jamasp.htpasswd; chgrp www-data /etc/nginx/jamasp.htpasswd; echo "PANEL PASSWORD: $PW"'
```

Capture that password and hand it to the operator — it is not recoverable afterwards (bcrypt). Store it in their password manager, not in the repo.

- [ ] **Step 3: Install the vhost and remove the distro default**

```bash
ssh jamasp 'cat > /etc/nginx/sites-available/jamasp-panel.conf' < ops/nginx/jamasp-panel.conf
ssh jamasp 'ln -sf /etc/nginx/sites-available/jamasp-panel.conf /etc/nginx/sites-enabled/jamasp-panel.conf && rm -f /etc/nginx/sites-enabled/default'
```

The distro default must go — it also claims `default_server`, and nginx refuses to start with two.

- [ ] **Step 4: Generate the real-IP snippet now that nginx exists**

```bash
ssh jamasp '/usr/local/sbin/refresh-cf-ranges.sh'
ssh jamasp 'head -3 /etc/nginx/conf.d/cloudflare-real-ip.conf; grep -c set_real_ip_from /etc/nginx/conf.d/cloudflare-real-ip.conf'
```

Expected: ~22 `set_real_ip_from` lines.

- [ ] **Step 5: Validate and reload**

```bash
ssh jamasp 'nginx -t'
ssh jamasp 'systemctl enable --now nginx && systemctl reload nginx && systemctl is-active nginx'
```

Expected: `syntax is ok`, `test is successful`, `active`.

- [ ] **Step 6: Verify basic auth challenges over loopback**

```bash
ssh jamasp 'curl -sSk -o /dev/null -w "%{http_code}\n" --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/'
```

Expected: `401`.

- [ ] **Step 7: Verify the panel is served when credentials are supplied**

```bash
ssh jamasp 'curl -sSk -u desk:PASSWORD --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/ | grep -c "Last ingest"'
```

Expected: `1` or more. Grepping for "Overview" would be a false pass — that is sidebar nav, present even when the page body has failed.

- [ ] **Step 8: Verify the catch-all swallows unknown hostnames**

```bash
ssh jamasp 'curl -sSk -o /dev/null -w "%{http_code}\n" --resolve bogus.example:443:127.0.0.1 https://bogus.example/ ; echo "exit=$?"'
```

Expected: a non-response — curl exits 52 ("empty reply from server"), which is what `return 444` produces.

- [ ] **Step 9: Commit**

```bash
git add ops/nginx/jamasp-panel.conf
git commit -m "ops: nginx vhost fronting the panel with TLS and basic auth"
```

---

### Task 4: Declare the public origin for Server Actions

**Files:**
- Modify: `panel/next.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a panel build that accepts Server Action POSTs whose Origin is `https://jamasp.mahdanian.xyz`.

The key is `experimental.serverActions.allowedOrigins` — verified against the installed Next.js 16.2.12 (`node_modules/next/dist/server/config-shared.d.ts`, inside `ExperimentalConfig`). Do not move it to the top level.

- [ ] **Step 1: Edit the config**

Replace `panel/next.config.ts` with:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The panel is reached through nginx at https://jamasp.mahdanian.xyz.
  // Server Actions reject POSTs whose Origin doesn't match the forwarded
  // host, so the public hostname has to be declared explicitly — otherwise
  // pages render fine and every mutating button fails.
  experimental: {
    serverActions: {
      allowedOrigins: ["jamasp.mahdanian.xyz"],
    },
  },
};

export default nextConfig;
```

- [ ] **Step 2: Deploy the config and rebuild on the host**

```bash
ssh jamasp 'cat > /home/jamasp/Jamasp/panel/next.config.ts' < panel/next.config.ts
ssh jamasp 'chown jamasp:jamasp /home/jamasp/Jamasp/panel/next.config.ts'
ssh jamasp 'sudo -u jamasp -i bash -lc "cd ~/Jamasp/panel && npm run build"'
```

Expected: a successful build. A config-key typo surfaces here as an "Invalid next.config.ts options detected" warning — treat that warning as a failure.

- [ ] **Step 3: Restart only the panel**

```bash
ssh jamasp 'systemctl restart jamasp-panel.service && sleep 3 && systemctl is-active jamasp-panel.service'
```

Expected: `active`. Do not touch any other unit.

- [ ] **Step 4: Verify the panel still serves through nginx**

```bash
ssh jamasp 'curl -sSk -u desk:PASSWORD --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/ | grep -c "Last ingest"'
```

Expected: `1` or more.

- [ ] **Step 5: Commit**

```bash
git add panel/next.config.ts
git commit -m "panel: allow server actions from the public origin"
```

Note: this file is also touched by nothing else in flight — but stage it explicitly regardless.

---

### Task 5: DNS record and per-hostname strict TLS

**Files:** none — Cloudflare API only.

**Interfaces:**
- Consumes: working origin from Tasks 1–4.
- Produces: public resolution of `jamasp.mahdanian.xyz` through the Cloudflare edge.

- [ ] **Step 1: Confirm the hostname is unused**

```bash
dig +short A jamasp.mahdanian.xyz
```

Expected: empty.

- [ ] **Step 2: Create the proxied A record**

Via the Cloudflare API tool:

```js
async () => cloudflare.request({
  method: "POST",
  path: "/zones/4f4fa848a174bf69d638b66d4e6fa29b/dns_records",
  body: {
    type: "A",
    name: "jamasp",
    content: "167.235.150.246",
    proxied: true,
    ttl: 1,
    comment: "Jamasp control panel origin",
  },
})
```

- [ ] **Step 3: Verify it resolves to Cloudflare, not the origin**

```bash
dig +short A jamasp.mahdanian.xyz
```

Expected: two Cloudflare addresses (104.x / 172.67.x). Seeing `167.235.150.246` means the record is not proxied — fix `proxied: true` before continuing, or the lockdown will block all traffic.

- [ ] **Step 4: Scope strict TLS to this hostname**

Read the existing entrypoint first so an existing rule is not destroyed:

```js
async () => cloudflare.request({
  method: "GET",
  path: "/zones/4f4fa848a174bf69d638b66d4e6fa29b/rulesets/phases/http_config_settings/entrypoint",
})
```

If it 404s there is no ruleset yet; create one containing only this rule. If it exists, append to its `rules` array and PUT the merged list:

```js
async () => cloudflare.request({
  method: "PUT",
  path: "/zones/4f4fa848a174bf69d638b66d4e6fa29b/rulesets/phases/http_config_settings/entrypoint",
  body: {
    name: "default",
    kind: "zone",
    phase: "http_config_settings",
    rules: [
      {
        action: "set_config",
        action_parameters: { ssl: "strict" },
        expression: '(http.host eq "jamasp.mahdanian.xyz")',
        description: "Full (strict) TLS for the Jamasp panel only",
        enabled: true,
      },
    ],
  },
})
```

**If the API rejects this because Configuration Rules are not on the Free plan**, apply the spec's fallback: leave the zone at `full`, change nothing zone-wide, and note the gap in Task 8's documentation. Do **not** flip the zone-level SSL setting.

- [ ] **Step 5: Verify the zone-level setting was not disturbed**

```js
async () => cloudflare.request({
  method: "GET",
  path: "/zones/4f4fa848a174bf69d638b66d4e6fa29b/settings/ssl",
})
```

Expected: still `full`.

- [ ] **Step 6: Verify public reachability and that the neighbour is unharmed**

From your workstation:

```bash
curl -sSI https://jamasp.mahdanian.xyz/ | head -1
curl -sS -o /dev/null -w "dashagh=%{http_code}\n" https://dashagh.mahdanian.xyz/
```

Expected: `HTTP/2 401` for the panel (basic auth reached through the edge — Access is not configured yet), and `dashagh` returning whatever it returned before this work (record the value; any change means the zone was disturbed).

---

### Task 6: Cloudflare Access in front of the hostname

**Files:** none — Cloudflare API only.

**Interfaces:**
- Consumes: the live hostname from Task 5.
- Produces: an Access application and allow-policy gating the hostname.

- [ ] **Step 1: Create the self-hosted application**

```js
async () => cloudflare.request({
  method: "POST",
  path: `/accounts/85799051dc45ac9a2add4892d13f4e58/access/apps`,
  body: {
    name: "Jamasp Panel",
    type: "self_hosted",
    domain: "jamasp.mahdanian.xyz",
    session_duration: "24h",
    app_launcher_visible: true,
    auto_redirect_to_identity: false,
  },
})
```

Record the returned `id` — the policy call needs it.

- [ ] **Step 2: Attach the allow policy**

Substitute the app id from Step 1:

```js
async () => cloudflare.request({
  method: "POST",
  path: `/accounts/85799051dc45ac9a2add4892d13f4e58/access/apps/<APP_ID>/policies`,
  body: {
    name: "Desk operators",
    decision: "allow",
    include: [
      { email: { email: "saman@mahdanian.xyz" } },
      { email: { email: "mahdanian.saman@gmail.com" } },
    ],
  },
})
```

- [ ] **Step 3: Read back what was actually created**

```js
async () => {
  const apps = await cloudflare.request({ method: "GET", path: `/accounts/85799051dc45ac9a2add4892d13f4e58/access/apps` });
  const app = apps.result.find(a => a.domain === "jamasp.mahdanian.xyz");
  const pol = await cloudflare.request({ method: "GET", path: `/accounts/85799051dc45ac9a2add4892d13f4e58/access/apps/${app.id}/policies` });
  return { app: { id: app.id, domain: app.domain, session: app.session_duration }, policies: pol.result };
}
```

Expected: one app, one `allow` policy listing both emails. Confirm the policy is not `bypass` — a bypass policy would silently disable the whole layer.

- [ ] **Step 4: Verify Access now intercepts**

From your workstation:

```bash
curl -sSI https://jamasp.mahdanian.xyz/ | head -3
```

Expected: a `302` whose `location` points at `mahdanian-saman-81.cloudflareaccess.com`. A `401` here means Access is not applied to the hostname — recheck the app's `domain`.

---

### Task 7: End-to-end acceptance and rollback drill

**Files:** none — verification only.

Run every item in the spec's acceptance list and record actual output. Do not mark any as passed by inference.

- [ ] **Step 1: Browser login flow**

Open `https://jamasp.mahdanian.xyz` in a browser. Expected, in order: Cloudflare Access one-time-PIN prompt → email PIN → basic auth dialog (`desk` + generated password) → Overview page showing "Last ingest".

- [ ] **Step 2: Exercise a real Server Action — the acceptance test that matters**

In the browser, go to `/schedule`, use "Schedule wakeup" to add a deepdive a few hours out, confirm it appears in the pending list, then cancel it.

Expected: both succeed with no error toast. A failure here means the proxy headers or `allowedOrigins` are wrong — reads would still have looked perfect, which is exactly why this step exists.

Then confirm it round-tripped to the database rather than just the UI:

```bash
ssh jamasp 'sudo -u jamasp -i bash -lc "cd ~/Jamasp && uv run jamasp wakeup list"'
```

- [ ] **Step 3: Verify Access cannot be bypassed at the origin**

```bash
curl -sSI --connect-timeout 10 --resolve jamasp.mahdanian.xyz:443:167.235.150.246 https://jamasp.mahdanian.xyz/ ; echo "exit=$?"
```

Expected: `exit=28` (timeout). Anything that returns HTTP means the lockdown is not working and Access is decorative.

- [ ] **Step 4: Re-confirm renewal**

```bash
ssh jamasp 'certbot renew --dry-run 2>&1 | tail -5'
```

Expected: simulated renewal succeeded.

- [ ] **Step 5: Rollback drill**

```bash
ssh jamasp 'systemctl stop nginx'
ssh -f -N -L 3300:127.0.0.1:3300 jamasp
curl -s http://127.0.0.1:3300/ | grep -c "Last ingest"
ssh jamasp 'systemctl start nginx && systemctl is-active nginx'
```

Expected: the tunnel still serves the panel with nginx down (rollback path intact), then nginx returns to `active`. Close the tunnel afterwards.

- [ ] **Step 6: Confirm no agent timers were disturbed**

```bash
ssh jamasp 'systemctl list-timers | grep jamasp'
ssh jamasp 'systemctl is-active jamasp-panel.service'
```

Expected: ingest/dispatch/scan/brief/watchdog/retro timers all still scheduled, with next-run times consistent with their normal cadence.

---

### Task 8: Document the runbook and merge

**Files:**
- Modify: `.claude/skills/deploy/SKILL.md`

- [ ] **Step 1: Correct the stale claim in the Panel section**

`.claude/skills/deploy/SKILL.md` item 6 of the Panel section currently reads:

> Access from a workstation: `ssh -L 3300:127.0.0.1:3300 jamasp@<host>` or `tailscale serve 3300`. The panel has NO auth of its own — never bind it to a public interface.

Replace the second sentence with a pointer to the new section: the panel is still bound to localhost and still has no auth of its own; public access is provided by the nginx + Access + nftables stack described below, and the SSH tunnel remains the fallback.

- [ ] **Step 2: Add a "Public access" section**

Document, in the same terse runbook voice as the rest of the file: the three layers and why each exists; the file inventory from this plan's File Structure table; the note that `ops/systemd-root/` units are root-owned and must **not** go through the `User=jamasp` install loop; the API-token prerequisite; the reinstall commands; and the rollback. If Task 5's Configuration Rule fell back, record that the zone remains at `full` and why.

- [ ] **Step 3: Verify the documented commands are the ones actually run**

Re-read the section against this plan's Tasks 1–6. Every path, unit name, and hostname must match what was really installed. Check `ssh jamasp 'ls /etc/systemd/system/jamasp-*'` against what the section claims.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/deploy/SKILL.md
git commit -m "docs(deploy): runbook for public panel access"
```

- [ ] **Step 5: Merge back to the shared tree — carefully**

The other agent may have landed commits on `main` in the meantime.

```bash
cd /Users/saman/Rabin/Jamasp
git status --porcelain          # if NOT empty, the other agent has work in
                                # flight — stop and coordinate before merging
git log --oneline -5
git merge --no-ff feat/panel-public-access -m "feat: serve the panel publicly at jamasp.mahdanian.xyz"
git log --oneline -3
```

If the shared tree has uncommitted changes, do **not** merge, do **not** stash them. Wait, or merge from a moment when it is clean.

- [ ] **Step 6: Remove the worktree**

```bash
git worktree remove ../Jamasp-panel-public
git worktree list
```

Expected: only the main tree remains.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| DNS + edge (proxied A record) | 5 |
| Per-hostname strict TLS, zone untouched | 5 (+ fallback documented in 8) |
| certbot DNS-01, credentials, deploy hook | 2 |
| Renewal proven by dry-run | 2, 7 |
| nginx vhost, basic auth, catch-all 444 | 3 |
| Real-IP restoration | 1 (script), 3 (activation) |
| Cloudflare Access app + policy | 6 |
| nftables lockdown + weekly refresh + fail-closed guard | 1 |
| Server Actions / `allowedOrigins` | 4, verified in 7 |
| Repo artifacts | 1, 3, 4, 8 |
| Human handoff (token, password, allowlist) | Prerequisite, 3 Step 2, 6 |
| All 9 acceptance criteria | 7 (plus 3 Step 6–8, 5 Step 6) |
| Rollback | 7 Step 5, 8 Step 2 |

**Placeholder scan:** `PASTE_TOKEN_HERE`, `PASSWORD`, and `<APP_ID>` are intentional runtime substitutions with explicit instructions for obtaining each, not unspecified work. No "TBD", no "add error handling", no "similar to Task N".

**Type/name consistency:** `inet jamasp_edge` with sets `cf_v4`/`cf_v6` is used identically in the nft file, the refresh script, and the `ExecStop` line. `/usr/local/sbin/refresh-cf-ranges.sh` matches across both units and Task 3 Step 4. `/etc/nftables.d/jamasp-edge.nft` matches between Task 1 Step 6 and `jamasp-edge.service`. Hostname, zone ID, and account ID match the spec verbatim.

**Ordering check:** the lockdown lands before anything listens on 80/443, so nginx is never briefly exposed; the certificate exists before the vhost that references it, so `nginx -t` cannot fail on missing files; DNS goes live only after the origin serves correctly; Access goes on last, once there is something to gate.
