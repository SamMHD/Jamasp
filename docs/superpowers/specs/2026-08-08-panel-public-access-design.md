# Jamasp Panel — Public Access Design Spec

**Date:** 2026-08-08
**Status:** Approved (brainstorming session with Saman)

## Purpose

Expose the Jamasp control panel at `https://jamasp.mahdanian.xyz` so the desk
can reach it from anywhere, without weakening the fact that the panel can
*act* — its server actions shell out to the `jamasp` CLI to schedule wakeups
and trigger agent runs. Whoever gets in can spend Claude quota, so the
perimeter is designed as three independent layers, not one password.

The panel itself is not modified beyond a proxy-compatibility setting. It
stays bound to `127.0.0.1:3300`, so the existing SSH-tunnel access path keeps
working unchanged and remains the rollback.

## Decisions made

| Question | Decision |
|---|---|
| Hostname | `jamasp.mahdanian.xyz` (zone already on Cloudflare) |
| Origin certificate | Let's Encrypt via certbot, DNS-01 with the Cloudflare plugin |
| Renewal | Ubuntu's packaged `certbot.timer` + `--deploy-hook` reloading nginx |
| Reverse proxy | nginx on the origin, TLS termination + HTTP basic auth |
| Identity | Cloudflare Access (one-time PIN) *in front of* basic auth |
| Origin lockdown | nftables: ports 80/443 reachable only from Cloudflare ranges |
| Zone SSL mode | Full (strict) scoped to this hostname only — zone stays `full` |
| Rate limiting | Out of scope (declined) |

## Environment (verified 2026-08-08)

- Host: Hetzner, Ubuntu 26.04 LTS, IPv4 `167.235.150.246`, IPv6
  `2a01:4f8:1c1a:dacf::1`. No firewall active, nothing on 80/443, no nginx or
  certbot installed. Node v22.23.2.
- `jamasp-panel.service` is a **system** unit (`User=jamasp`), active, serving
  `127.0.0.1:3300`.
- Cloudflare zone `mahdanian.xyz` = `4f4fa848a174bf69d638b66d4e6fa29b`,
  account `85799051dc45ac9a2add4892d13f4e58`, Free plan, active.
- Zone settings today: `ssl=full`, `min_tls_version=1.0`,
  `always_use_https=off`, `automatic_https_rewrites=on`.
- `jamasp.mahdanian.xyz` is unused. `dashagh.mahdanian.xyz` is a proxied AAAA
  on the same zone — **it must not be disturbed**.
- Zero Trust org already exists: auth domain
  `mahdanian-saman-81.cloudflareaccess.com`, with a `onetimepin` identity
  provider configured. No Access applications defined yet.
- The Cloudflare credential available to tooling can write DNS and Access but
  **cannot mint API tokens** (`/user/tokens` returns 9109). Token creation is
  a human dashboard step.

## Architecture

Request path:

```
browser
  → Cloudflare edge            (TLS to client; Access policy gate)
  → origin :443                (nftables: Cloudflare source ranges only)
  → nginx                      (LE cert; basic auth; proxy headers)
  → 127.0.0.1:3300             (next start, unchanged)
```

Each layer covers a distinct threat, not a strictly nested one — **the
layers are not fully independent, and nftables does not make Access
unbypassable.** Cloudflare's published IP ranges are shared infrastructure:
anyone with a free Cloudflare account can point their own zone at
`167.235.150.246` and use an Origin Rule to override the Host/SNI sent to
the origin to `jamasp.mahdanian.xyz` (a documented technique — Certitude,
Nov 2023). That request arrives from an allow-listed Cloudflare IP, so
nftables passes it; it presents the right Host, so it matches the panel
vhost instead of the `444` catch-all; and Cloudflare Access is never
consulted, because Access is enforced on *our* zone's edge configuration,
not at the origin, and this request never touched our zone. What actually
stops that path is nginx's basic auth (bcrypt, 144-bit random password) —
which is precisely why it is being kept rather than dropped once Access
was added. See
`docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md` for
the proper fix (origin-side Access JWT validation). Given all that, what
each layer *does* reliably do: nftables blocks direct-IP scans and
background internet noise (traffic that never went through Cloudflare at
all); Access gates human sign-in and provides identity/audit for requests
arriving via our hostname on our zone; nginx refuses to forward any
request — via either path — that lacks valid basic-auth credentials.

### 1. DNS and edge configuration

- `A jamasp.mahdanian.xyz → 167.235.150.246`, **proxied**. No AAAA — the
  origin is reached over IPv4 only, which keeps one path to reason about.
  (IPv6 firewall rules are still installed, since nginx listens on `[::]`.)
- SSL mode: a **Configuration Rule** on the `http_config_settings` phase
  matching `http.host eq "jamasp.mahdanian.xyz"`, setting SSL to
  `strict`. The zone-level `ssl=full` is left untouched so `dashagh` cannot
  break.
  - **Fallback, if Configuration Rules are unavailable on the Free plan:**
    leave the zone at `full` and record the gap in the deploy skill. `full`
    still encrypts edge→origin; only certificate validation is lost. Do
    **not** flip the zone-wide setting to strict.
- `always_use_https` and `min_tls_version` are left as-is: zone-wide settings
  that would affect `dashagh`. The nginx `80 → 443` redirect covers this
  hostname.

### 2. Origin certificate and renewal

- Packages: `certbot`, `python3-certbot-dns-cloudflare` (apt).
- Credentials: `/etc/letsencrypt/cloudflare.ini`, mode `0600`, root-owned,
  containing `dns_cloudflare_api_token`. Never in the repo.
- Issue:
  `certbot certonly --dns-cloudflare --dns-cloudflare-credentials
  /etc/letsencrypt/cloudflare.ini -d jamasp.mahdanian.xyz
  --deploy-hook "systemctl reload nginx"`
- The deploy hook persists into the renewal config, so the packaged
  `certbot.timer` renews and reloads nginx unattended.
- DNS-01 is chosen over HTTP-01 deliberately: it needs no inbound port 80,
  works with the orange cloud on, and is unaffected by the nftables lockdown.

### 3. nginx

Config checked into the repo at `ops/nginx/jamasp-panel.conf`, installed to
`/etc/nginx/sites-available/` and symlinked. Two server blocks:

**Default (catch-all):** `listen 80 default_server`, `listen 443 ssl
default_server` on v4 and v6, using the same certificate, returning `444` for
any unrecognised Host. A direct-IP probe gets a closed connection.

**Panel vhost** for `jamasp.mahdanian.xyz`:
- `listen 80` → `301` to HTTPS; `listen 443 ssl` with HTTP/2.
- `auth_basic "Jamasp"` + `auth_basic_user_file /etc/nginx/jamasp.htpasswd`
  (generated with `htpasswd` from `apache2-utils`; bcrypt).
- `proxy_pass http://127.0.0.1:3300` with `Host`, `X-Forwarded-Host`,
  `X-Forwarded-Proto https`, `X-Real-IP`, `X-Forwarded-For`, and the
  `Upgrade`/`Connection` pair.
- `set_real_ip_from` for every Cloudflare range + `real_ip_header
  CF-Connecting-IP`, so access logs record actual clients rather than edge IPs.
- Response headers: HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`.

### 4. Cloudflare Access

- Self-hosted application on `jamasp.mahdanian.xyz`, created via API.
- One policy, action `allow`, matching email in
  `{saman@mahdanian.xyz, mahdanian.saman@gmail.com}`, using the existing
  `onetimepin` IdP. Session duration 24h.
- Two prompts are expected and intended: Access PIN first, then basic auth.
  Access is the identity layer; basic auth is the backstop that still holds if
  an Access misconfiguration ever opens up.

### 5. Origin lockdown (nftables)

A dedicated table so nothing else on the box is affected, and **no
default-drop policy** — only traffic to 80/443 from non-Cloudflare sources is
dropped. SSH cannot be caught by this rule, which removes the lockout risk.

```
table inet jamasp_edge {
  set cf_v4 { type ipv4_addr; flags interval; }
  set cf_v6 { type ipv6_addr; flags interval; }
  chain input {
    type filter hook input priority filter; policy accept;
    tcp dport { 80, 443 } iif lo accept
    tcp dport { 80, 443 } meta nfproto ipv4 ip  saddr != @cf_v4 drop
    tcp dport { 80, 443 } meta nfproto ipv6 ip6 saddr != @cf_v6 drop
  }
}
```

- Sets are populated from `https://www.cloudflare.com/ips-v4` and `ips-v6` by
  `ops/scripts/refresh-cf-ranges.sh`, run by a **daily** systemd timer
  (`jamasp-cf-ranges.timer`), both checked into the repo. (Originally
  weekly; shortened post-launch — see the hardening note below.)
- **Failure guard:** if either fetch fails or returns an implausible list
  (below `MIN_V4`/`MIN_V6`, or fewer CIDRs than are currently loaded), the
  script does not apply the fetched data and still exits non-zero. An empty
  set would drop Cloudflare itself and take the panel down — the stale list
  is always the safer state.
- **Hardened post-launch (branch review finding C1):** `jamasp-edge.nft`
  recreates its sets *empty* on every load (the `table`/`delete table` pair
  used for idempotent reloads), and `jamasp-edge.service` runs that reload
  immediately before this script on every boot. So "exits non-zero without
  touching the live ruleset" was true in steady state but **false at
  boot** — there was no previous ruleset to fall back to, and one transient
  fetch failure at boot could leave the sets empty (dropping all inbound
  80/443, including Cloudflare's) until the next timer fire. The script now
  also caches the last-accepted lists to `/var/lib/jamasp/cf-ranges.v4` and
  `.v6` on every success, and loads that cache into the live sets on any
  failure — including at boot — before still exiting non-zero. The timer
  moved from weekly to daily in the same change, to shrink worst-case
  staleness if a cache load is ever needed for real.
- Loopback is explicitly allowed so on-origin verification with `curl` works.

### 6. Panel change (the one real trap)

The panel's mutations — mark inbox read, add/cancel wakeup, "Run now" — are
Next.js Server Actions, which reject requests whose `Origin` does not match
the forwarded host. Misconfigured proxy headers produce a panel where every
page renders correctly and every button fails: a failure that is easy to ship
and unpleasant to diagnose.

Mitigation is twofold: nginx sets `Host`/`X-Forwarded-Host`/
`X-Forwarded-Proto` explicitly (above), and `panel/next.config.ts` declares
`jamasp.mahdanian.xyz` in `serverActions.allowedOrigins`. **The exact config
key must be verified against the installed Next.js 16 documentation during
implementation, not assumed** — it moved between major versions. Acceptance
requires firing a real server action end-to-end, not merely loading pages.

## Repo artifacts

- `ops/nginx/jamasp-panel.conf` — the vhost and catch-all.
- `ops/nftables/jamasp-edge.nft` — the table skeleton.
- `ops/scripts/refresh-cf-ranges.sh` — range refresh with the failure guard.
- `ops/systemd-root/jamasp-cf-ranges.{service,timer}` — daily refresh.
- `panel/next.config.ts` — `serverActions.allowedOrigins`.
- `.claude/skills/deploy/SKILL.md` — new "Public access" section making the
  whole thing reproducible on a rebuilt host, and correcting the existing
  claim that the panel "has NO auth of its own — never bind it to a public
  interface".

Secrets that never enter the repo: `/etc/nginx/jamasp.htpasswd`,
`/etc/letsencrypt/cloudflare.ini`.

## Human handoff

1. Create a scoped Cloudflare API token in the dashboard —
   **Zone:DNS:Edit + Zone:Zone:Read, restricted to `mahdanian.xyz`** — and
   hand over the value. Tooling cannot mint this. Implementation writes it to
   `/etc/letsencrypt/cloudflare.ini` with the correct ownership and mode.
2. Choose the basic-auth username and password for the htpasswd file.
3. Confirm the Access email allowlist above is correct and complete.

## Error handling and failure modes

| Failure | Behaviour |
|---|---|
| Cert renewal fails | Existing cert serves until expiry; `certbot.timer` retries twice daily. Detected by `certbot renew --dry-run` in acceptance, not by expiry. |
| CF range refresh fails | Script aborts non-zero; live ranges are preserved — from the already-loaded set, or from the on-disk cache if the set was empty (e.g. at boot). Panel unaffected once a cache exists (see C1 hardening, above); a first-ever run with no cache and a failed fetch is the one case that can leave the sets empty. |
| Ranges go stale between refreshes | Cloudflare announces changes well in advance; daily cadence is ample. Worst case is a partial outage, fixed by a manual refresh run. |
| nginx down | Panel unreachable publicly; SSH tunnel to 3300 unaffected. |
| Access misconfigured/open | Basic auth still blocks. |
| Basic auth credential leaked | **This path gets in.** Neither Access nor nftables reliably stops it: an attacker can reach the origin via another Cloudflare tenant's zone with Host/SNI overridden to `jamasp.mahdanian.xyz` (see Architecture, above), which nftables cannot distinguish from legitimate traffic and which never touches our zone's Access policy. Basic auth is the layer actually carrying this risk today; see `2026-08-09-access-jwt-origin-auth-design.md` for the planned origin-side JWT check. |
| Panel service down | nginx returns 502; no data at risk. |

## Acceptance criteria

Every item is a command with an expected result. No step is considered done
on the strength of "it should work".

1. `nginx -t` passes.
2. On the origin: `curl -sI --resolve jamasp.mahdanian.xyz:443:127.0.0.1
   https://jamasp.mahdanian.xyz/` → `401` with a `WWW-Authenticate` header.
3. From a workstation: `curl -sI https://jamasp.mahdanian.xyz/` → `302` to
   `mahdanian-saman-81.cloudflareaccess.com` (Access is live).
4. From a workstation: `curl -sI --connect-timeout 10 --resolve
   jamasp.mahdanian.xyz:443:167.235.150.246 https://jamasp.mahdanian.xyz/` →
   connection times out (confirms the origin lockdown blocks direct-IP
   access from a non-Cloudflare source; it does not by itself prove Access
   can't be bypassed via another Cloudflare tenant's zone — see
   Architecture, above).
5. `certbot renew --dry-run` → success.
6. Browser: PIN → basic auth → Overview renders the text "Last ingest".
7. Browser: schedule a wakeup, then cancel it → both succeed (Server Actions
   work through the proxy).
8. `systemctl stop nginx`; SSH tunnel to `127.0.0.1:3300` still serves the
   panel → rollback path intact. Restart nginx afterwards.
9. `dashagh.mahdanian.xyz` still loads → the zone was not disturbed.

## Rollback

`systemctl disable --now nginx`, delete the `jamasp` DNS record, and
`nft delete table inet jamasp_edge`. The panel service, its port binding, and
the SSH-tunnel workflow are untouched throughout, so rollback restores the
exact prior state.

## Out of scope

- nginx rate limiting (considered, declined).
- Exposing anything other than the panel on this host.
- Moving the panel off `127.0.0.1` or adding in-app authentication or roles.
- Zone-wide TLS hardening (`min_tls_version`, `always_use_https`) — affects
  `dashagh`, unrelated to this goal.
- Mobile-optimised panel layouts (already out of scope in the panel spec).
