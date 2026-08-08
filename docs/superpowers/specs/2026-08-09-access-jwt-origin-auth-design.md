# Access JWT Origin Authentication — Design Spec

**Date:** 2026-08-09
**Status:** Draft — open decisions at the end need a ruling before planning
**Supersedes part of:** `2026-08-08-panel-public-access-design.md` (the basic-auth layer)

## Purpose

Replace HTTP basic auth on `jamasp.mahdanian.xyz` with cryptographic
verification of the Cloudflare Access JWT at the origin. Same security
guarantee, no second password prompt, no shared static credential.

## Why basic auth exists today (the hole it actually plugs)

It is tempting to read the current stack as three redundant identity layers.
It is not. Basic auth closes one specific hole that neither of the other two
layers touches.

The nftables lockdown restricts the origin to **Cloudflare's published IP
ranges** — but those ranges are shared by every Cloudflare customer. An
attacker can:

1. Point their own Cloudflare zone at `167.235.150.246`.
2. Add a Transform Rule overriding the Host header to `jamasp.mahdanian.xyz`.
3. Send requests that arrive from a legitimate Cloudflare IP, pass the
   firewall, match our `server_name`, and reach the panel.

Cloudflare Access never sees these requests: Access is enforced at the edge
for **our** zone, not theirs. Today, basic auth is the only thing that stops
them.

So any replacement must be **tenant-specific** — it must distinguish "came
through *our* Access application" from "came through *some* Cloudflare zone".
Verifying the Access JWT does exactly that, because the `aud` claim is unique
to our application and cannot be minted by another tenant.

## What Cloudflare sends

On every request it proxies to the origin, Access includes:

- **`Cf-Access-Jwt-Assertion`** header — a signed JWT (also present as the
  `CF_Authorization` cookie).
- **`Cf-Access-Authenticated-User-Email`** — convenience header, useful in
  access logs.

### Validation requirements (all mandatory)

| Check | Value |
|---|---|
| Signature | RS256, against the team JWKS |
| JWKS URL | `https://mahdanian-saman-81.cloudflareaccess.com/cdn-cgi/access/certs` |
| `aud` | `b54e2de7426792dfaa6f9134c8c5d01b36491a72e4ed0e3c7f5ac7f812d27264` |
| `iss` | `https://mahdanian-saman-81.cloudflareaccess.com` |
| `exp` / `nbf` | Must be current |

### Two ways to get this wrong

1. **Checking only that the header is present.** Any Cloudflare tenant can
   set an arbitrary header on their own proxied request. A config like
   `if ($http_cf_access_jwt_assertion = "") { return 403; }` looks like
   security and provides none — it would leave the exact hole basic auth is
   currently closing.
2. **Trusting `Cf-Access-Authenticated-User-Email`** for anything but logging
   unless the JWT it arrived with has been validated. It is equally
   forgeable on its own.

Verifying `aud` is what makes this tenant-specific. Signature verification
alone is not enough: every Cloudflare Access team gets JWTs, and without an
`aud` check a token from an unrelated team could be replayed — subject to
issuer differences, but `aud` is the claim that actually pins it to *this*
application.

## Architecture

Unchanged: nftables lockdown, Cloudflare Access at the edge, nginx
terminating TLS and reverse-proxying to the panel on `127.0.0.1:3300`, panel
still localhost-bound with no auth of its own.

Changed: nginx validates the Access JWT instead of challenging for basic auth.

```
browser → Cloudflare edge (Access issues JWT)
        → origin :443   (nftables: Cloudflare ranges only)
        → nginx         (verify JWT: signature + aud + iss + exp)
        → 127.0.0.1:3300
```

### Implementation vehicle

`auth_jwt` is NGINX Plus only, so open-source nginx needs one of:

| Option | Cost | Assessment |
|---|---|---|
| **njs module** (`libnginx-mod-http-js`, 0.9.4 available in apt on this host) | ~50 lines JS + JWKS handling | Recommended. In-process, no extra service, no extra port. njs ships crypto primitives sufficient for RS256 verification. |
| **`auth_request` to a local validator** (small Go/Python service) | New service, new unit, new failure mode | More mature JWT libraries, but adds a daemon to supervise and a second thing that can be down. |
| **Next.js middleware** | No nginx change | Rejected: contradicts the panel spec's "no in-app auth" boundary, and puts the security decision inside the app it is protecting. |

### JWKS handling

Cloudflare rotates signing keys, so the key set cannot be baked in.

Recommended: a systemd timer fetches the JWKS to a file on disk
(e.g. `/etc/nginx/access-jwks.json`) every few hours; njs reads that file.
This avoids runtime network I/O in the request path and reuses the
**fail-closed pattern already established** by `refresh-cf-ranges.sh` — if
the fetch fails or returns something implausible, the previous JWKS stays in
place and the script exits non-zero rather than writing an empty key set.

Rotation safety: Cloudflare publishes new keys before retiring old ones, and
the endpoint returns multiple keys during overlap, so a few hours of staleness
is tolerable. A stale-beyond-rotation JWKS rejects valid tokens and locks the
desk out of the panel — which is why the refresh must be monitored, and why
the rollout below keeps a way back in.

## Rollout — staged, not a cutover

This is the part that matters operationally. Removing basic auth and adding
JWT validation in one step means a mistake locks everyone out of the panel,
including the person trying to fix it.

1. **Add JWT validation while basic auth stays in place.** Both must pass.
   Verify normal browser access still works end to end, including a Server
   Action (schedule + cancel a wakeup).
2. **Prove the negative cases** (below) before trusting it.
3. **Only then remove `auth_basic`**, in its own commit, so it can be
   reverted independently.
4. Keep `/etc/nginx/jamasp.htpasswd` on disk for one renewal cycle before
   deleting, so re-enabling is a one-line change.

The SSH tunnel to `127.0.0.1:3300` remains the escape hatch throughout, and
it bypasses nginx entirely — that is the recovery path if JWKS handling ever
locks the front door.

## Testing

Positive:
- A real browser session (Access PIN → panel) renders Overview.
- A Server Action round-trips: schedule a wakeup, cancel it, confirm via
  `uv run jamasp wakeup list`.
- SWR polling of `/api/*` keeps working — those carry the same cookie.

Negative — each must be rejected with 401/403:
- No `Cf-Access-Jwt-Assertion` header at all.
- A syntactically valid JWT signed by the **wrong key** (self-signed with the
  correct `aud`). This is the test that proves signature verification is real.
- A JWT with a valid signature but the **wrong `aud`**. This is the test that
  proves the tenant-spoofing hole is closed — the whole point of the change.
- An **expired** token.

The wrong-`aud` and wrong-key cases are the ones worth writing carefully; the
missing-header case passes trivially even in a broken implementation.

## Failure modes

| Failure | Behaviour |
|---|---|
| JWKS fetch fails | Previous key set stays live; refresh exits non-zero. No request-path impact. |
| JWKS stale past rotation | Valid tokens rejected → panel returns 403. Recovery: SSH tunnel, manual refresh. |
| njs module missing after an nginx upgrade | `nginx -t` fails; nginx does not reload. Fails closed. |
| Access app deleted or misconfigured | No valid JWT arrives → nginx rejects. Fails **closed**, unlike relying on Access alone. |
| Panel down | 502, unchanged from today. |

## Out of scope

- Per-user authorization inside the panel (all Access-approved users remain
  equally privileged).
- Replacing the nftables lockdown — it stays; it is cheap and blocks scan
  noise before TLS.
- Cloudflare Tunnel migration, which would make both the firewall and this
  work unnecessary but is a larger change.
- Service tokens for non-browser/CLI access — none needed today.

## Open decisions (need a ruling before planning)

1. **njs vs. `auth_request` sidecar.** Recommendation: njs — fewer moving
   parts, no extra daemon.
2. **JWKS refresh via systemd timer + file, vs. njs fetching at runtime with
   an in-memory cache.** Recommendation: timer + file, matching the existing
   `refresh-cf-ranges.sh` pattern and keeping network I/O out of the request
   path.
3. **After cutover, remove basic auth entirely or keep it for
   `/api/*`?** Recommendation: remove entirely — a half-applied rule is
   harder to reason about than either extreme.
