# Access JWT Origin Authentication — Design Spec

**Date:** 2026-08-09
**Status:** Draft — open decisions at the end need a ruling before planning
**Extends:** `2026-08-08-panel-public-access-design.md` (the basic-auth layer)

## Purpose

Verify the Cloudflare Access JWT at the origin so normal browser use needs no
second password prompt — while **keeping basic auth as a fallback** for when
Access is unavailable or cannot be used.

nginx accepts a request if **either** check passes (`satisfy any`):

1. a valid Cloudflare Access JWT, or
2. valid HTTP basic auth credentials.

## What this does and does not buy

Being precise about this matters, because the obvious reading is wrong.

**It does not raise the security floor.** With `satisfy any`, the weakest
accepted credential still defines the perimeter, and that remains the basic
auth password. An attacker who cannot mint a valid JWT simply meets the basic
auth challenge — exactly as today.

**What it does buy:**

- **No second prompt** in normal use. The everyday path becomes Access PIN
  only.
- **Defence against Access misconfiguration.** If the Access app were deleted
  or a policy flipped to `bypass`, basic auth still guards the origin.
- **No lockout risk.** This is the decisive operational argument. A JWT-only
  design fails closed on a stale JWKS — valid tokens get rejected and the desk
  loses the panel it would use to diagnose the problem. With the fallback, a
  JWKS problem degrades to "you get a password prompt again", which is an
  inconvenience rather than an outage.
- **A path to tightening later.** Once JWT validation has proven itself over
  time, `satisfy any` can become `satisfy all`, or basic auth can be dropped —
  a one-line change, reversible, decided with evidence instead of upfront.

## Why basic auth exists at all (the hole it plugs)

It is tempting to read the stack as three redundant identity layers. It is
not. Basic auth closes one specific hole neither other layer touches.

The nftables lockdown restricts the origin to **Cloudflare's published IP
ranges** — but those ranges are shared by every Cloudflare customer. An
attacker can:

1. Point their own Cloudflare zone at `167.235.150.246`.
2. Add a Transform Rule overriding the Host header to `jamasp.mahdanian.xyz`.
3. Send requests that arrive from a legitimate Cloudflare IP, pass the
   firewall, match our `server_name`, and reach the panel.

Cloudflare Access never sees these requests: Access is enforced at the edge
for **our** zone, not theirs. Basic auth is what stops them — which is
precisely why it is being kept rather than replaced.

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
   `if ($http_cf_access_jwt_assertion = "") { ... }` looks like security and
   provides none.
2. **Trusting `Cf-Access-Authenticated-User-Email`** for anything but logging
   unless the JWT it arrived with has been validated. It is equally forgeable
   on its own.

Verifying `aud` is what pins a token to *this* application; signature
verification alone does not, since every Access team gets signed JWTs.

## Architecture

Unchanged: nftables lockdown, Cloudflare Access at the edge, nginx
terminating TLS and reverse-proxying to the panel on `127.0.0.1:3300`, panel
still localhost-bound with no auth of its own.

Changed: nginx gains JWT validation alongside the existing basic auth.

```
browser → Cloudflare edge (Access issues JWT)
        → origin :443   (nftables: Cloudflare ranges only)
        → nginx         satisfy any:
                          (a) valid Access JWT  → allow, no prompt
                          (b) valid basic auth  → allow
                          neither               → 401 basic auth challenge
        → 127.0.0.1:3300
```

### The critical implementation property: fail closed, then fall through

The JWT validator must **deny** on every error — malformed token, unknown
key, JWKS unreadable, clock problems. Under `satisfy any` a denial is not a
lockout; it falls through to the basic auth challenge. A validator that
"allows on error" would silently disable the JWT layer while appearing to
work, and would be indistinguishable from a working config in casual testing.

There is an nginx detail to get right: the fallback must surface as a **401
with a `WWW-Authenticate` header** so browsers actually prompt. A validator
returning 403 under `satisfy any` can produce a hard 403 instead of a prompt.
The plan must test the observable behaviour — "a browser with no JWT gets a
password prompt" — not merely that the config loads.

### Implementation vehicle

`auth_jwt` is NGINX Plus only, so open-source nginx needs one of:

| Option | Cost | Assessment |
|---|---|---|
| **njs module** (`libnginx-mod-http-js`, 0.9.4 available in apt on this host) | ~50 lines JS + JWKS handling | Recommended. In-process, no extra service or port. njs ships crypto primitives sufficient for RS256. |
| **`auth_request` to a local validator** (small Go/Python service) | New service, new unit, new failure mode | More mature JWT libraries, but another daemon to supervise and another thing that can be down. |
| **Next.js middleware** | No nginx change | Rejected: contradicts the panel spec's "no in-app auth" boundary and puts the security decision inside the app being protected. |

### JWKS handling

Cloudflare rotates signing keys, so the key set cannot be baked in.

Recommended: a systemd timer fetches the JWKS to `/etc/nginx/access-jwks.json`
every few hours; njs reads that file. This keeps network I/O out of the
request path and reuses the **fail-closed pattern already proven** by
`refresh-cf-ranges.sh` — if the fetch fails or returns something implausible,
the previous JWKS stays and the script exits non-zero rather than writing an
empty key set.

Cloudflare publishes new keys before retiring old ones and serves both during
overlap, so a few hours of staleness is tolerable. And because of the basic
auth fallback, even total JWKS failure degrades to a password prompt.

## Rollout

The fallback design removes the need for a staged cutover — there is no
moment where a mistake locks anyone out. Still:

1. Add JWT validation with `satisfy any`. Verify a normal browser session
   reaches the panel **without** a basic auth prompt.
2. Verify basic auth still works when no valid JWT is present.
3. Run the negative tests below before considering it trustworthy.
4. Leave `satisfy any` in place. Revisit tightening only with evidence.

The SSH tunnel to `127.0.0.1:3300` remains the escape hatch throughout and
bypasses nginx entirely.

## Testing

Positive:
- A real browser session (Access PIN → panel) renders Overview **with no
  basic auth prompt**. The absence of the prompt is the observable proof the
  JWT path is working.
- A Server Action round-trips: schedule a wakeup, cancel it, confirm with
  `uv run jamasp wakeup list`.
- SWR polling of `/api/*` keeps working — same cookie.
- With no JWT, basic auth credentials still grant access.

Negative — each must fall through to a **401 basic auth challenge**, never a
pass-through:
- No `Cf-Access-Jwt-Assertion` header at all.
- A syntactically valid JWT signed by the **wrong key** (self-signed, correct
  `aud`). Proves signature verification is real.
- A valid signature with the **wrong `aud`**. Proves the token is pinned to
  this application.
- An **expired** token.
- JWKS file missing or corrupt — validator denies, basic auth still works.

The wrong-key and wrong-`aud` cases are the ones worth writing carefully. A
missing-header test passes even in a completely broken implementation, and
under `satisfy any` a broken validator is invisible unless tested this way.

## Failure modes

| Failure | Behaviour |
|---|---|
| JWKS fetch fails | Previous key set stays live; refresh exits non-zero. No request-path impact. |
| JWKS stale past rotation | JWT rejected → basic auth prompt returns. Degraded UX, not an outage. |
| njs module missing after an nginx upgrade | `nginx -t` fails; nginx does not reload. Fails closed. |
| Access app deleted or misconfigured | No valid JWT → basic auth still guards the origin. |
| Validator has a bug and denies everything | Basic auth prompt returns; panel still reachable. |
| Validator has a bug and allows everything | **Worst case** — silently removes the JWT layer. Only the negative tests above catch this. |
| Panel down | 502, unchanged. |

## Out of scope

- Per-user authorization inside the panel (all Access-approved users remain
  equally privileged).
- Replacing the nftables lockdown — it stays; cheap, and blocks scan noise
  before TLS.
- Cloudflare Tunnel migration, which would obviate both the firewall and this
  work but is a larger change.
- Service tokens for non-browser/CLI access — none needed today.
- Removing basic auth. Explicitly retained as the fallback.

## Open decisions (need a ruling before planning)

1. **njs vs. `auth_request` sidecar.** Recommendation: njs — fewer moving
   parts, no extra daemon.
2. **JWKS refresh via systemd timer + file, vs. njs fetching at runtime with
   an in-memory cache.** Recommendation: timer + file, matching the existing
   `refresh-cf-ranges.sh` pattern and keeping network I/O out of the request
   path.
3. **Should the basic auth password be rotated** when this lands? It has been
   shared in a chat transcript. Recommendation: yes, rotate as part of the
   work — it is a one-line `htpasswd` regeneration, and the fallback becomes
   more load-bearing under this design, not less.
