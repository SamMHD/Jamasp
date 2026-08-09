# Access JWT Origin Authentication — Design Spec

**Date:** 2026-08-09
**Status:** Implemented 2026-08-09 — see "What was observed" at the end
**Extends:** `2026-08-08-panel-public-access-design.md` (the basic-auth layer)
**Plan:** `docs/superpowers/plans/2026-08-09-access-jwt-origin-auth.md`

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

Changed: nginx gains JWT validation alongside the existing basic auth, via a
new localhost-bound sidecar on `127.0.0.1:3301`.

```
browser → Cloudflare edge (Access issues JWT)
        → origin :443   (nftables: Cloudflare ranges only)
        → nginx         satisfy any:
                          (a) auth_request → 127.0.0.1:3301 /auth
                                200 → allow, no prompt
                                403 → denied, try (b)
                                5xx → mapped to 403 by error_page
                          (b) valid basic auth → allow
                          neither → 401 basic auth challenge
        → 127.0.0.1:3300  (panel, unchanged)
```

The sidecar binds loopback only. It is never proxied to directly and has no
route from the outside; nginx reaches it solely through the `internal`
check location.

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
| **`auth_request` to a local validator** (Python + PyJWT on `127.0.0.1:3301`) | New service, new unit, new failure mode | **Chosen.** Signature and claim verification are done by a library many people have attacked, not by hand-rolled code. The cost is a second process — see "The sidecar's own failure mode" below, which is not optional to handle. |
| **njs module** (`libnginx-mod-http-js`, 0.9.4 in apt on this host) | ~50 lines JS + JWKS handling | Fewer moving parts and no extra daemon, but the RS256 verification would be ours to write against njs crypto primitives. Rejected in favour of a battle-tested library. |
| **Next.js middleware** | No nginx change | Rejected: contradicts the panel spec's "no in-app auth" boundary and puts the security decision inside the app being protected. |

Python rather than Go: it lands in the existing `uv` venv alongside the
`jamasp` CLI, deploys the way everything else here already does, and adds no
toolchain or build step to the host. PyJWT is the reference Python
implementation and its RS256 path is backed by `cryptography`.

The daemon is a `jamasp` CLI subcommand (`jamasp authd`), matching how every
other long-running piece of this system is started.

### The sidecar's own failure mode — and why `error_page` is load-bearing

This is the specific cost of choosing a sidecar over njs, and getting it
wrong quietly breaks the no-lockout guarantee that motivated the whole
fallback design.

Under `satisfy any`, nginx treats **401 and 403** from an access-phase
handler as "this handler denied, try the next one". Any *other* status —
including the **500/502/504** nginx produces when an `auth_request` upstream
is refused, hung, or dead — is not a denial. It finalises the request
immediately. Basic auth is never consulted.

So the naive configuration turns "the sidecar is down" into **500 for
everyone**, including someone typing the correct basic auth password. That
is precisely the lockout the fallback exists to prevent, reintroduced by the
mechanism meant to avoid it.

The fix is to convert upstream failure into a denial *inside* the check
location, so it re-enters the normal fall-through path:

```nginx
location = /_access-check {
    internal;
    proxy_pass              http://127.0.0.1:3301/auth;
    proxy_pass_request_body off;
    proxy_set_header        Content-Length "";
    proxy_connect_timeout   1s;
    proxy_read_timeout      2s;

    # Sidecar refused, hung or dead must read as "denied", not "error" —
    # 5xx escapes `satisfy any` and finalises the request, bypassing the
    # basic auth fallback entirely.
    error_page 500 502 503 504 = @access_denied;
}

location @access_denied {
    internal;
    return 403;
}
```

The short timeouts matter for the same reason: a hung sidecar must fail fast
into that path rather than stalling every page load for the default 60s.

**This must be proven by stopping the service and observing a 401, not by
reading the config.** A `502 → 403 → basic auth prompt` chain is exactly the
kind of thing that looks right and behaves otherwise.

### JWKS handling

Cloudflare rotates signing keys, so the key set cannot be baked in.

The sidecar parses the key set with PyJWT's `PyJWKSet` and caches it in
memory with a TTL (default 1h). Every successful fetch is written to a
last-known-good file; on startup — or after a failed refresh — that file is
what the validator uses. This reuses the **fail-closed cache pattern already
proven** by `refresh-cf-ranges.sh`: never replace good data with nothing, and
make the failure visible in the log rather than silently degrading.

A refresh failure therefore has no request-path impact at all; the previous
keys stay live. A restart during a Cloudflare outage still comes up with
working keys instead of starting blind.

Cloudflare publishes new keys before retiring old ones and serves both during
overlap, so an hour of staleness is tolerable. And because of the basic auth
fallback, even total JWKS failure degrades to a password prompt.

### Configuration, and why it refuses to start without it

The AUD tag and team domain come from the environment
(`JAMASP_ACCESS_AUD`, `JAMASP_ACCESS_TEAM_DOMAIN`), read from the existing
`~/.config/jamasp/env`. **The daemon exits non-zero if either is unset.**

This is a fail-closed requirement, not tidiness. A validator that defaulted
`aud` to empty and skipped the audience check would accept *any* Cloudflare
Access token from *any* team — the "validator allows everything" row in the
failure table, arrived at through a missing environment variable. Refusing
to start is loud; silently accepting everything is not.

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
pass-through and never a 5xx:
- No `Cf-Access-Jwt-Assertion` header at all.
- A syntactically valid JWT signed by the **wrong key** (self-signed, correct
  `aud`). Proves signature verification is real.
- A valid signature with the **wrong `aud`**. Proves the token is pinned to
  this application.
- A valid signature with the **wrong `iss`**.
- An **expired** token.
- A token whose header says `alg: none`, and one re-signed with `alg: HS256`
  using the RSA public key as the HMAC secret. Proves algorithm confusion is
  not possible.
- Backstop JWKS file missing or corrupt — validator denies, basic auth works.
- **`jamasp-authd` stopped** — the `error_page` path. Must give 401, not 500.
- **`jamasp-authd` hung** (e.g. `SIGSTOP`) — must give 401 within ~3s, not a
  60s stall.

The wrong-key, wrong-`aud` and algorithm-confusion cases are the ones worth
writing carefully. A missing-header test passes even in a completely broken
implementation, and under `satisfy any` a broken validator is invisible
unless tested this way.

The two service-failure cases are equally load-bearing but for the opposite
reason: they are the ones that fail *closed on the wrong axis*, taking the
panel down rather than letting an attacker in.

## Failure modes

| Failure | Behaviour |
|---|---|
| JWKS fetch fails | Previous key set stays live, in memory or from the backstop file. Logged. No request-path impact. |
| JWKS stale past rotation | JWT rejected → basic auth prompt returns. Degraded UX, not an outage. |
| Backstop file missing or corrupt at startup | Empty key set → every JWT denied → basic auth prompt, until the first successful fetch. Fails closed. |
| **Sidecar down, hung, or crash-looping** | `error_page` maps 5xx to 403 → basic auth prompt. **Only correct if that mapping is present** — without it, hard 500 for everyone. |
| Sidecar fails to start (missing `JAMASP_ACCESS_AUD`) | Unit fails loudly; requests get the basic auth prompt via the row above. |
| `pyjwt`/`cryptography` missing after a bad deploy | Sidecar won't start; same as above. |
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

## Decisions (ruled 2026-08-09)

1. **Vehicle: `auth_request` sidecar**, against the original njs
   recommendation. Rationale given: prefer the battle-tested option for the
   part that is actually security-critical — signature and claim
   verification. Accepted cost: a second process, and the `error_page`
   handling above becomes mandatory rather than nice-to-have.
2. **JWKS: library cache + on-disk backstop.** In-memory TTL cache written
   through to a last-known-good file, so a cold start during a Cloudflare
   outage still comes up with usable keys. No separate systemd timer.
3. **Rotate the basic auth password** as part of this work. It has been
   through a chat transcript, and this design leaves it load-bearing: it is
   the layer holding the Cloudflare tenant-spoofing line described above.

## What was observed (2026-08-09)

Measured against the live host, not inferred from the config.

| Check | Result |
|---|---|
| Sidecar denies with no header / junk token / unknown `kid` | 403 in all three cases |
| Sidecar bind | `127.0.0.1:3301` only — not reachable off-host |
| JWKS fetched from the real team endpoint | 2 keys, matching the live endpoint's count |
| Restart during normal operation | loads 2 keys from the backstop file, no network needed |
| Origin with no credentials at all | **401**, never 200 |
| `/api/*` (the SWR polling path) with no credentials | **401** — the gate is not just on navigations |
| **`jamasp-authd` stopped** | **401** with `WWW-Authenticate: Basic realm="Jamasp"` — the `error_page` mapping works |
| **`jamasp-authd` SIGSTOP-hung** | **401 in 2.04s**, matching `proxy_read_timeout 2s`; clean recovery on SIGCONT |
| Basic auth rotation | old password → 401, new → 200, file ownership preserved (`root:www-data 640`) |
| SSH tunnel to `127.0.0.1:3300` | 200 — the escape hatch still bypasses nginx entirely |
| Public URL | still 302 to the Access auth domain |

Every rejection in `AccessVerifier` was also proven at the unit level against
PyJWT 2.13.0 — wrong signing key, wrong `aud`, wrong `iss`, expired, missing
`exp`, unknown `kid`, `alg: none`, and RS256→HS256 confusion using the public
key as the HMAC secret. 202 tests pass in the merged tree.

### Two things worth recording for next time

**The hung-sidecar case is the one the design nearly missed.** A refused
connection produces 502 quickly; a *hung* process leaves the TCP connection
established, so `proxy_connect_timeout` never fires and only
`proxy_read_timeout` saves you. Without it the failure is not an error page
but a 60-second stall on every request, which reads as "the panel is slow"
rather than "auth is broken".

**A malformed test token can prove nothing and look like it proved
something.** `eyJ...fQ.e30.x` is rejected before the key lookup, because `x`
is not valid base64 — no JWKS fetch, no log line, and a 403 that would look
identical if the whole validator were broken. Exercising the fetch path needs
a structurally valid RS256 token with an unknown `kid`.

### Still open

- The end-to-end browser path (Access PIN → panel with **no** password
  prompt) is the one claim not machine-verifiable from here. It needs a
  private window, since a saved basic auth credential would make the absence
  of a prompt meaningless.
- No `OnFailure=` alerting on `jamasp-authd`, the CF-ranges refresh units, or
  `certbot.service`. A crash-looping sidecar is currently silent — it
  degrades to a password prompt rather than an outage, which is the correct
  behaviour but also the kind that goes unnoticed for weeks.
