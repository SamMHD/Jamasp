# Access JWT Origin Authentication — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the Cloudflare Access JWT at the origin so normal browser
use needs no second password prompt, while keeping HTTP basic auth as a
fallback that still works when the JWT path is unavailable.

**Architecture:** A localhost-bound Python daemon (`jamasp authd` on
`127.0.0.1:3301`) verifies the `Cf-Access-Jwt-Assertion` header with PyJWT and
answers 200 or 403. nginx consults it via `auth_request` under `satisfy any`,
so a denial falls through to the existing basic auth challenge. Upstream 5xx
is mapped to 403 by `error_page` — without that, a dead sidecar becomes a hard
500 for everyone and defeats the fallback.

**Tech Stack:** Python 3.12+ (3.14.4 on the host), PyJWT with the `crypto`
extra, `httpx` (already a dependency), stdlib `ThreadingHTTPServer`, Click,
pytest, nginx 1.28.3 (`--with-http_auth_request_module`, confirmed present),
systemd.

**Spec:** `docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md`

## Global Constraints

- **Fail closed on every error.** Malformed token, unknown `kid`, unreadable
  JWKS, clock problems, unexpected exceptions — all deny. Never allow-on-error.
- **Pin the algorithm.** `algorithms=["RS256"]` on every `jwt.decode` call.
  Never read the algorithm from the token header.
- **Deny with 403, never 401.** Under `satisfy any`, 401 from the sidecar can
  win over basic auth's 401 and suppress the `WWW-Authenticate` header.
- **Exact values**, copied verbatim from the spec:
  - AUD: `b54e2de7426792dfaa6f9134c8c5d01b36491a72e4ed0e3c7f5ac7f812d27264`
  - Issuer: `https://mahdanian-saman-81.cloudflareaccess.com`
  - JWKS: `https://mahdanian-saman-81.cloudflareaccess.com/cdn-cgi/access/certs`
  - Header: `Cf-Access-Jwt-Assertion`
  - Sidecar bind: `127.0.0.1:3301`. Panel stays on `127.0.0.1:3300`.
- **No secrets or deployment-specific values committed as defaults.** AUD and
  team domain come from `JAMASP_ACCESS_AUD` / `JAMASP_ACCESS_TEAM_DOMAIN`. The
  daemon exits non-zero if either is unset. The repo is public.
- **Do not touch the host repo checkout** (`/home/jamasp/Jamasp`) except in
  the deployment tasks, and then only via `git pull`.
- **Only restart `jamasp-authd` and `nginx`** on the host. Leave the six
  analyst timers, the panel unit, and `jamasp-edge` alone.
- **The SSH tunnel to `127.0.0.1:3300` is the escape hatch** and bypasses
  nginx entirely. It must keep working throughout.
- TDD: write the failing test, watch it fail, implement, watch it pass, commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `jamasp/accessjwt.py` (create) | Pure validation: JWKS cache with on-disk backstop, plus token verification. No HTTP server, no Click. This is the security-critical unit and is tested in isolation. |
| `jamasp/authd.py` (create) | The HTTP daemon: `ThreadingHTTPServer`, request handler, `/auth` endpoint. Translates a verification result into 200/403. Knows nothing about crypto. |
| `jamasp/cli.py` (modify) | Add the `authd` command. |
| `tests/test_accessjwt.py` (create) | Signature, `aud`, `iss`, `exp`, algorithm-confusion, and JWKS-cache tests against a locally generated RSA keypair. |
| `tests/test_authd.py` (create) | Server-level tests: status codes, missing header, verifier exceptions. |
| `pyproject.toml` (modify) | Add `pyjwt[crypto]>=2.9`. |
| `ops/systemd/jamasp-authd.service` (create) | Runs `jamasp authd`. Goes in `ops/systemd/` (not `-root/`) because it must run as `jamasp`. |
| `ops/nginx/jamasp-panel.conf` (modify) | `satisfy any`, `auth_request`, the internal check location, and the `error_page` 5xx→403 mapping. |
| `.claude/skills/deploy/SKILL.md` (modify) | Runbook section for the sidecar. |
| `.claude/skills/access-whitelist/SKILL.md` (modify) | Layer table and the "they also need the basic auth password" claim, which stops being true. |
| `docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md` (modify) | Status → Implemented, with what was actually observed. |

---

### Task 1: JWKS cache with on-disk backstop

**Files:**
- Create: `jamasp/accessjwt.py`
- Create: `tests/test_accessjwt.py`
- Modify: `pyproject.toml`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class JwksCache(jwks_url: str, backstop_path: Path, ttl_seconds: int = 3600, transport: httpx.BaseTransport | None = None)`
    — `transport` exists so tests can drive it without network access.
  - `JwksCache.signing_key(kid: str) -> jwt.PyJWK | None` — returns `None` when
    the `kid` is unknown, never raises for network reasons.

- [ ] **Step 1: Add the dependency**

In `pyproject.toml`, add to `dependencies`:

```toml
    "pyjwt[crypto]>=2.9",
```

Then run `uv sync` and confirm it resolves:

```bash
uv sync && uv run python -c "import jwt, cryptography; print(jwt.__version__, cryptography.__version__)"
```

If `cryptography` has no wheel for the local Python, report that as BLOCKED
rather than pinning an old version — the host is on Python 3.14.4.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_accessjwt.py`:

```python
import json
import time

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from jamasp.accessjwt import JwksCache


def _keypair():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwks_dict(private_key, kid="test-kid"):
    """Build a JWKS document from a private key's public half."""
    import jwt

    pub = private_key.public_key()
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(pub, as_dict=True)
    jwk.update({"kid": kid, "alg": "RS256", "use": "sig"})
    return {"keys": [jwk]}


def _transport(payload, status=200):
    """An httpx transport that always answers with `payload`."""
    def handler(request):
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def test_fetch_populates_cache_and_writes_backstop(tmp_path):
    key = _keypair()
    backstop = tmp_path / "jwks.json"
    cache = JwksCache(
        "https://example.test/certs",
        backstop,
        transport=_transport(_jwks_dict(key)),
    )

    assert cache.signing_key("test-kid") is not None
    assert json.loads(backstop.read_text())["keys"][0]["kid"] == "test-kid"


def test_unknown_kid_returns_none(tmp_path):
    key = _keypair()
    cache = JwksCache(
        "https://example.test/certs",
        tmp_path / "jwks.json",
        transport=_transport(_jwks_dict(key)),
    )

    assert cache.signing_key("no-such-kid") is None


def test_startup_loads_backstop_when_fetch_fails(tmp_path):
    key = _keypair()
    backstop = tmp_path / "jwks.json"
    backstop.write_text(json.dumps(_jwks_dict(key)))

    def boom(request):
        raise httpx.ConnectError("no network")

    cache = JwksCache(
        "https://example.test/certs",
        backstop,
        transport=httpx.MockTransport(boom),
    )

    # The network is down, but the backstop carries us.
    assert cache.signing_key("test-kid") is not None


def test_failed_refresh_keeps_previous_keys(tmp_path):
    key = _keypair()
    calls = {"n": 0}

    def flaky(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(200, json=_jwks_dict(key))
        raise httpx.ConnectError("no network")

    cache = JwksCache(
        "https://example.test/certs",
        tmp_path / "jwks.json",
        ttl_seconds=0,  # every lookup re-fetches
        transport=httpx.MockTransport(flaky),
    )

    assert cache.signing_key("test-kid") is not None  # first fetch succeeds
    assert cache.signing_key("test-kid") is not None  # second fails, keys stay


def test_corrupt_backstop_is_survivable(tmp_path):
    backstop = tmp_path / "jwks.json"
    backstop.write_text("{{{ not json")

    def boom(request):
        raise httpx.ConnectError("no network")

    cache = JwksCache(
        "https://example.test/certs",
        backstop,
        transport=httpx.MockTransport(boom),
    )

    # No keys, but no crash either — the caller denies.
    assert cache.signing_key("test-kid") is None


def test_empty_keyset_response_does_not_clobber_backstop(tmp_path):
    key = _keypair()
    backstop = tmp_path / "jwks.json"
    backstop.write_text(json.dumps(_jwks_dict(key)))

    cache = JwksCache(
        "https://example.test/certs",
        backstop,
        transport=_transport({"keys": []}),
    )

    # An empty key set is implausible, not authoritative. Same reasoning as
    # the CIDR floors in refresh-cf-ranges.sh.
    assert cache.signing_key("test-kid") is not None
    assert json.loads(backstop.read_text())["keys"][0]["kid"] == "test-kid"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_accessjwt.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.accessjwt'`

- [ ] **Step 4: Implement `JwksCache`**

Create `jamasp/accessjwt.py`:

```python
"""Cloudflare Access JWT verification for the panel's origin auth sidecar.

Every path in this module fails closed: anything unexpected denies. Under
nginx's `satisfy any` a denial is not a lockout — it falls through to the
basic auth challenge — so there is never a reason to allow on error.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

import httpx
import jwt

log = logging.getLogger("jamasp.accessjwt")


class JwksCache:
    """Cloudflare's signing keys, cached in memory and mirrored to disk.

    The on-disk copy is a last-known-good backstop, not a cache for speed:
    it is what lets the daemon come up with usable keys after a restart
    during a Cloudflare outage. Same reasoning as the CIDR cache in
    refresh-cf-ranges.sh — never replace good data with nothing.
    """

    def __init__(
        self,
        jwks_url: str,
        backstop_path: Path,
        ttl_seconds: int = 3600,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._url = jwks_url
        self._backstop = Path(backstop_path)
        self._ttl = ttl_seconds
        self._transport = transport
        self._lock = threading.Lock()
        self._keys: dict[str, jwt.PyJWK] = {}
        # -inf, not 0: time.monotonic()'s epoch is boot on Linux, so a plain
        # 0 would make the first lookup skip its refresh on any host that has
        # been up for less than `ttl` seconds.
        self._fetched_at = float("-inf")
        self._load_backstop()

    # -- public ---------------------------------------------------------

    def signing_key(self, kid: str) -> jwt.PyJWK | None:
        """The key for `kid`, refreshing first if the cache is stale.

        Returns None for an unknown kid or when no keys are available at
        all. Never raises for network or parse reasons.
        """
        with self._lock:
            if time.monotonic() - self._fetched_at >= self._ttl:
                self._refresh_locked()
            key = self._keys.get(kid)

        if key is None and kid:
            # A kid we have never seen is the signature of a rotation that
            # happened inside the TTL window. One forced refresh, then give
            # up until the next natural expiry.
            with self._lock:
                if time.monotonic() - self._fetched_at > 60:
                    self._refresh_locked()
                key = self._keys.get(kid)

        return key

    # -- internals ------------------------------------------------------

    def _refresh_locked(self) -> bool:
        try:
            with httpx.Client(transport=self._transport, timeout=10) as client:
                resp = client.get(self._url)
                resp.raise_for_status()
                doc = resp.json()
        except Exception as exc:  # network, TLS, JSON — all the same to us
            log.warning("JWKS fetch from %s failed: %s", self._url, exc)
            self._fetched_at = time.monotonic()  # don't hammer on every request
            return False

        keys = self._parse(doc)
        if not keys:
            # An empty or unparseable key set is implausible, not
            # authoritative. Keep what we have rather than going dark.
            log.warning("JWKS from %s had no usable keys — keeping previous", self._url)
            self._fetched_at = time.monotonic()
            return False

        self._keys = keys
        self._fetched_at = time.monotonic()
        self._write_backstop(doc)
        log.info("JWKS refreshed: %d key(s)", len(keys))
        return True

    @staticmethod
    def _parse(doc: object) -> dict[str, jwt.PyJWK]:
        # Note: PyJWKSet.from_dict raises PyJWKSetError on an empty `keys`
        # array rather than returning an empty set, so the "implausible
        # response" case arrives here as an exception. Both routes end up
        # returning {}, which the caller treats as "keep what we have".
        try:
            keyset = jwt.PyJWKSet.from_dict(doc)
        except Exception as exc:
            log.warning("JWKS did not parse: %s", exc)
            return {}
        return {k.key_id: k for k in keyset.keys if k.key_id}

    def _load_backstop(self) -> None:
        try:
            doc = json.loads(self._backstop.read_text())
        except FileNotFoundError:
            log.info("no JWKS backstop at %s yet", self._backstop)
            return
        except Exception as exc:
            log.warning("JWKS backstop at %s unreadable: %s", self._backstop, exc)
            return

        keys = self._parse(doc)
        if keys:
            self._keys = keys
            log.info("loaded %d key(s) from backstop %s", len(keys), self._backstop)

    def _write_backstop(self, doc: object) -> None:
        try:
            self._backstop.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._backstop.with_suffix(".tmp")
            tmp.write_text(json.dumps(doc))
            tmp.replace(self._backstop)  # atomic; never a half-written file
        except Exception as exc:
            log.warning("could not write JWKS backstop %s: %s", self._backstop, exc)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_accessjwt.py -v`
Expected: PASS, 6/6, no warnings.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml uv.lock jamasp/accessjwt.py tests/test_accessjwt.py
git commit -m "feat(authd): JWKS cache with last-known-good on-disk backstop"
```

---

### Task 2: Token verification

**Files:**
- Modify: `jamasp/accessjwt.py`
- Modify: `tests/test_accessjwt.py`

**Interfaces:**
- Consumes: `JwksCache.signing_key(kid) -> jwt.PyJWK | None` from Task 1.
- Produces:
  - `class AccessVerifier(jwks: JwksCache, audience: str, issuer: str)`
  - `AccessVerifier.verify(token: str) -> str | None` — returns the
    authenticated email on success (empty string if the token carries none),
    `None` on any failure. Never raises.
  - `ACCESS_HEADER = "Cf-Access-Jwt-Assertion"`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_accessjwt.py`:

```python
from jamasp.accessjwt import AccessVerifier

AUD = "test-audience-tag"
ISS = "https://team.cloudflareaccess.test"


def _verifier(tmp_path, key, kid="test-kid", audience=AUD, issuer=ISS):
    cache = JwksCache(
        "https://example.test/certs",
        tmp_path / "jwks.json",
        transport=_transport(_jwks_dict(key, kid=kid)),
    )
    return AccessVerifier(cache, audience=audience, issuer=issuer)


def _token(key, kid="test-kid", **overrides):
    import jwt as pyjwt

    now = int(time.time())
    claims = {
        "aud": [AUD],
        "iss": ISS,
        "iat": now,
        "exp": now + 3600,
        "email": "saman@mahdanian.xyz",
        "sub": "user-uuid",
    }
    claims.update(overrides)
    return pyjwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})


def test_valid_token_returns_email(tmp_path):
    key = _keypair()
    assert _verifier(tmp_path, key).verify(_token(key)) == "saman@mahdanian.xyz"


def test_wrong_signing_key_is_rejected(tmp_path):
    """The single most important test here: proves signature checking is real.

    Correct aud, correct iss, correct kid — signed by a key that is not ours.
    """
    ours, theirs = _keypair(), _keypair()
    assert _verifier(tmp_path, ours).verify(_token(theirs)) is None


def test_wrong_audience_is_rejected(tmp_path):
    """Proves the token is pinned to THIS application.

    Every Access team gets validly-signed JWTs; aud is what makes ours ours.
    """
    key = _keypair()
    assert _verifier(tmp_path, key).verify(_token(key, aud=["some-other-app"])) is None


def test_wrong_issuer_is_rejected(tmp_path):
    key = _keypair()
    bad = _token(key, iss="https://attacker.cloudflareaccess.test")
    assert _verifier(tmp_path, key).verify(bad) is None


def test_expired_token_is_rejected(tmp_path):
    key = _keypair()
    now = int(time.time())
    stale = _token(key, iat=now - 7200, exp=now - 3600)
    assert _verifier(tmp_path, key).verify(stale) is None


# The two algorithm-confusion tokens below are assembled by hand rather than
# with pyjwt.encode. PyJWT's *encoder* refuses to produce either one — it
# raises InvalidKeyError for an asymmetric key used as an HMAC secret. That
# guard protects people writing signers; it says nothing about our verifier,
# and an attacker is under no obligation to use PyJWT. Building the token
# manually is what actually exercises the decode path.

def _b64(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unsigned_parts(alg, claims):
    header = json.dumps({"alg": alg, "kid": "test-kid"}).encode()
    return f"{_b64(header)}.{_b64(json.dumps(claims).encode())}"


def _claims(**overrides):
    now = int(time.time())
    c = {"aud": [AUD], "iss": ISS, "iat": now, "exp": now + 3600, "email": "a@b.c"}
    c.update(overrides)
    return c


def test_alg_none_is_rejected(tmp_path):
    """Algorithm confusion: an unsigned token must never be accepted."""
    key = _keypair()
    unsigned = _unsigned_parts("none", _claims()) + "."
    assert _verifier(tmp_path, key).verify(unsigned) is None


def test_hs256_signed_with_public_key_is_rejected(tmp_path):
    """The classic RS256→HS256 confusion attack.

    The RSA public key is not secret — it is published in the JWKS. If the
    verifier honoured the token's own `alg`, an attacker could HMAC-sign a
    token of their choosing with that public key and be believed.
    """
    import hashlib
    import hmac

    from cryptography.hazmat.primitives import serialization

    key = _keypair()
    pub_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    signing_input = _unsigned_parts("HS256", _claims())
    sig = hmac.new(pub_pem, signing_input.encode(), hashlib.sha256).digest()
    forged = f"{signing_input}.{_b64(sig)}"

    assert _verifier(tmp_path, key).verify(forged) is None


def test_unknown_kid_is_rejected(tmp_path):
    key = _keypair()
    assert _verifier(tmp_path, key).verify(_token(key, kid="rotated-away")) is None


def test_garbage_token_is_rejected(tmp_path):
    key = _keypair()
    v = _verifier(tmp_path, key)
    for junk in ["", "not-a-jwt", "a.b.c", "....", "Bearer xyz"]:
        assert v.verify(junk) is None


def test_missing_exp_is_rejected(tmp_path):
    """A token with no expiry would be valid forever."""
    import jwt as pyjwt

    key = _keypair()
    now = int(time.time())
    forever = pyjwt.encode(
        {"aud": [AUD], "iss": ISS, "iat": now, "email": "x@y.z"},
        key,
        algorithm="RS256",
        headers={"kid": "test-kid"},
    )
    assert _verifier(tmp_path, key).verify(forever) is None


def test_no_keys_available_denies(tmp_path):
    """JWKS unreachable and no backstop — deny, don't crash."""
    key = _keypair()

    def boom(request):
        raise httpx.ConnectError("no network")

    cache = JwksCache(
        "https://example.test/certs",
        tmp_path / "jwks.json",
        transport=httpx.MockTransport(boom),
    )
    assert AccessVerifier(cache, audience=AUD, issuer=ISS).verify(_token(key)) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_accessjwt.py -v -k "not cache and not backstop and not kid_returns"`
Expected: FAIL — `ImportError: cannot import name 'AccessVerifier'`

- [ ] **Step 3: Implement `AccessVerifier`**

Append to `jamasp/accessjwt.py`:

```python
ACCESS_HEADER = "Cf-Access-Jwt-Assertion"

# Pinned, never read from the token. A verifier that honours the token's own
# `alg` can be defeated by re-signing with HS256 using the RSA public key —
# which is not secret.
ALGORITHMS = ["RS256"]


class AccessVerifier:
    """Verifies a Cloudflare Access JWT against this application."""

    def __init__(self, jwks: JwksCache, audience: str, issuer: str) -> None:
        if not audience or not issuer:
            # Belt and braces: the CLI already refuses to start without
            # these. An empty audience would disable the check that pins a
            # token to THIS app, accepting any Access token from any team.
            raise ValueError("AccessVerifier requires a non-empty audience and issuer")
        self._jwks = jwks
        self._audience = audience
        self._issuer = issuer

    def verify(self, token: str) -> str | None:
        """The authenticated email, or None if the token is not acceptable."""
        if not token:
            return None

        try:
            kid = jwt.get_unverified_header(token).get("kid")
        except Exception:
            return None
        if not kid:
            return None

        key = self._jwks.signing_key(kid)
        if key is None:
            log.info("no signing key for kid=%s", kid)
            return None

        try:
            claims = jwt.decode(
                token,
                key=key.key,
                algorithms=ALGORITHMS,
                audience=self._audience,
                issuer=self._issuer,
                options={"require": ["exp", "iat", "aud", "iss"]},
            )
        except jwt.InvalidTokenError as exc:
            log.info("token rejected: %s", exc)
            return None
        except Exception as exc:  # nothing gets through on an unexpected error
            log.warning("token verification raised: %s", exc)
            return None

        return claims.get("email", "")
```

- [ ] **Step 4: Run the full file to verify everything passes**

Run: `uv run pytest tests/test_accessjwt.py -v`
Expected: PASS, 18/18, output pristine.

Every rejection in this task was confirmed against PyJWT 2.13.0 before this
plan was written, with the exception types below. If any of these instead
*accepts*, that is a real finding, not a test bug — stop and report it.

| Case | Expected exception |
|---|---|
| wrong signing key | `InvalidSignatureError` |
| wrong `aud`, or an `aud` list not containing ours | `InvalidAudienceError` |
| wrong `iss` | `InvalidIssuerError` |
| expired | `ExpiredSignatureError` |
| `alg: none`, or HS256 forged with the public key | `InvalidAlgorithmError` |
| missing `exp` | `MissingRequiredClaimError` |
| malformed / junk | `DecodeError` |

- [ ] **Step 5: Commit**

```bash
git add jamasp/accessjwt.py tests/test_accessjwt.py
git commit -m "feat(authd): verify Access JWT signature, aud, iss and expiry"
```

---

### Task 3: The daemon and its CLI command

**Files:**
- Create: `jamasp/authd.py`
- Create: `tests/test_authd.py`
- Modify: `jamasp/cli.py`

**Interfaces:**
- Consumes: `AccessVerifier`, `JwksCache`, `ACCESS_HEADER` from Tasks 1–2.
- Produces:
  - `build_server(verifier, host="127.0.0.1", port=3301) -> ThreadingHTTPServer`
  - `jamasp authd [--host] [--port] [--jwks-cache PATH]` CLI command.
  - HTTP contract: `GET /auth` → **200** allow, **403** deny. Any other path
    → 404. Any other method → 405.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_authd.py`:

```python
import threading

import httpx
import pytest

from jamasp.authd import build_server


class FakeVerifier:
    """Stands in for AccessVerifier — the crypto is tested in test_accessjwt."""

    def __init__(self, result="saman@mahdanian.xyz", raises=False):
        self.result = result
        self.raises = raises
        self.seen = []

    def verify(self, token):
        self.seen.append(token)
        if self.raises:
            raise RuntimeError("verifier exploded")
        return self.result


@pytest.fixture
def server_url():
    servers = []

    def _start(verifier):
        srv = build_server(verifier, host="127.0.0.1", port=0)
        servers.append(srv)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{srv.server_address[1]}"

    yield _start
    for srv in servers:
        srv.shutdown()
        srv.server_close()


def test_valid_token_gets_200(server_url):
    url = server_url(FakeVerifier())
    r = httpx.get(f"{url}/auth", headers={"Cf-Access-Jwt-Assertion": "tok"})
    assert r.status_code == 200


def test_rejected_token_gets_403(server_url):
    url = server_url(FakeVerifier(result=None))
    r = httpx.get(f"{url}/auth", headers={"Cf-Access-Jwt-Assertion": "tok"})
    assert r.status_code == 403


def test_missing_header_gets_403(server_url):
    url = server_url(FakeVerifier())
    r = httpx.get(f"{url}/auth")
    assert r.status_code == 403


def test_403_never_carries_www_authenticate(server_url):
    """Under `satisfy any` a 401 from here can suppress basic auth's own
    challenge. This endpoint must deny with 403 and nothing else."""
    url = server_url(FakeVerifier(result=None))
    r = httpx.get(f"{url}/auth", headers={"Cf-Access-Jwt-Assertion": "tok"})
    assert r.status_code == 403
    assert "www-authenticate" not in {k.lower() for k in r.headers}


def test_verifier_exception_denies(server_url):
    """An unexpected crash must deny, not 500 — nginx maps 5xx to 403 too,
    but the daemon should not be relying on that."""
    url = server_url(FakeVerifier(raises=True))
    r = httpx.get(f"{url}/auth", headers={"Cf-Access-Jwt-Assertion": "tok"})
    assert r.status_code == 403


def test_authenticated_email_is_exposed_for_logging(server_url):
    url = server_url(FakeVerifier())
    r = httpx.get(f"{url}/auth", headers={"Cf-Access-Jwt-Assertion": "tok"})
    assert r.headers.get("X-Access-User") == "saman@mahdanian.xyz"


def test_unknown_path_gets_404(server_url):
    url = server_url(FakeVerifier())
    assert httpx.get(f"{url}/something").status_code == 404


def test_post_gets_405(server_url):
    url = server_url(FakeVerifier())
    assert httpx.post(f"{url}/auth").status_code == 405


def test_header_is_case_insensitive(server_url):
    """nginx forwards headers as sent; HTTP header names are case-insensitive
    and Cloudflare's casing is not a contract."""
    v = FakeVerifier()
    url = server_url(v)
    r = httpx.get(f"{url}/auth", headers={"cf-access-jwt-assertion": "tok"})
    assert r.status_code == 200
    assert v.seen == ["tok"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_authd.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.authd'`

- [ ] **Step 3: Implement the daemon**

Create `jamasp/authd.py`:

```python
"""Origin auth sidecar for the panel — answers nginx's auth_request.

Contract: GET /auth → 200 (allow) or 403 (deny). Nothing else, ever.

403 rather than 401 is deliberate. nginx's `satisfy any` treats 401 as
sticky, so a 401 from here could win over the basic auth module's own 401
and strip the WWW-Authenticate header the browser needs in order to prompt.
"""
from __future__ import annotations

import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from jamasp.accessjwt import ACCESS_HEADER

log = logging.getLogger("jamasp.authd")


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "jamasp-authd"
    sys_version = ""

    # Injected by build_server.
    verifier = None

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's contract
        if self.path.split("?", 1)[0] != "/auth":
            self._respond(404)
            return

        token = self.headers.get(ACCESS_HEADER, "")
        try:
            email = self.verifier.verify(token)
        except Exception as exc:
            # Should be unreachable — AccessVerifier.verify swallows its own
            # errors. Deny anyway; an exception must never mean "allow".
            log.warning("verifier raised: %s", exc)
            self._respond(403)
            return

        if email is None:
            self._respond(403)
            return

        self._respond(200, extra={"X-Access-User": email})

    def do_POST(self) -> None:  # noqa: N802
        self._respond(405)

    def _respond(self, status: int, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # Default goes to stderr per-request and would flood the journal;
        # nginx's own access log already records every one of these.
        pass


def build_server(verifier, host: str = "127.0.0.1", port: int = 3301):
    """A threading HTTP server bound to `host:port` using `verifier`.

    Pass port=0 in tests to get an ephemeral port.
    """
    handler = type("_BoundHandler", (_Handler,), {"verifier": verifier})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_authd.py -v`
Expected: PASS, 9/9.

- [ ] **Step 5: Add the CLI command**

In `jamasp/cli.py`, add to the imports near the other `from jamasp import ...`
lines (they are alphabetical):

```python
from jamasp import authd as authd_mod
```

and, next to the other `@main.command()` definitions, add:

```python
@main.command()
@click.option("--host", default="127.0.0.1", show_default=True)
@click.option("--port", default=3301, show_default=True, type=int)
@click.option(
    "--jwks-cache",
    default=None,
    help="last-known-good JWKS path [default: ~/.local/state/jamasp/access-jwks.json]",
)
def authd(host, port, jwks_cache):
    """Run the Cloudflare Access JWT sidecar for nginx's auth_request."""
    import logging
    import os

    from jamasp.accessjwt import AccessVerifier, JwksCache

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    audience = os.environ.get("JAMASP_ACCESS_AUD", "").strip()
    team_domain = os.environ.get("JAMASP_ACCESS_TEAM_DOMAIN", "").strip()
    if not audience or not team_domain:
        # Fail closed and loudly. Defaulting the audience to empty would
        # skip the check that pins a token to THIS application, accepting
        # any Access token from any Cloudflare team.
        raise click.ClickException(
            "JAMASP_ACCESS_AUD and JAMASP_ACCESS_TEAM_DOMAIN must both be set "
            "(see ~/.config/jamasp/env)"
        )

    team_domain = team_domain.removeprefix("https://").rstrip("/")
    issuer = f"https://{team_domain}"

    cache_path = Path(
        jwks_cache
        or os.environ.get("JAMASP_ACCESS_JWKS_CACHE")
        or Path.home() / ".local/state/jamasp/access-jwks.json"
    )

    jwks = JwksCache(f"{issuer}/cdn-cgi/access/certs", cache_path)
    verifier = AccessVerifier(jwks, audience=audience, issuer=issuer)

    server = authd_mod.build_server(verifier, host=host, port=port)
    click.echo(f"jamasp authd listening on {host}:{port} for {issuer}", err=True)
    server.serve_forever()
```

- [ ] **Step 6: Verify the fail-closed startup check**

```bash
env -u JAMASP_ACCESS_AUD -u JAMASP_ACCESS_TEAM_DOMAIN uv run jamasp authd; echo "exit=$?"
```

Expected: an error mentioning both variables, `exit=1`. It must **not** start.

- [ ] **Step 7: Run the whole suite**

Run: `uv run pytest -q`
Expected: everything green, including the 22 pre-existing test files.

- [ ] **Step 8: Commit**

```bash
git add jamasp/authd.py jamasp/cli.py tests/test_authd.py
git commit -m "feat(authd): localhost auth_request sidecar and jamasp authd command"
```

---

### Task 4: Ship the sidecar to the host (nothing user-visible yet)

This task deploys and proves the daemon against **real** Cloudflare keys while
nginx still knows nothing about it. Nothing user-facing changes; if the daemon
is wrong, the panel is unaffected.

**Files:**
- Create: `ops/systemd/jamasp-authd.service`

**Interfaces:**
- Consumes: `jamasp authd` from Task 3.
- Produces: a running `jamasp-authd.service` on the host answering
  `127.0.0.1:3301`.

- [ ] **Step 1: Write the unit**

Create `ops/systemd/jamasp-authd.service`. It belongs in `ops/systemd/`, not
`ops/systemd-root/`: the deploy skill's install loop injects `User=jamasp`
into everything here, which is exactly what this needs.

```ini
[Unit]
Description=Jamasp panel — Cloudflare Access JWT sidecar on 127.0.0.1:3301
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=%h/Jamasp
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=JAMASP_ROOT=%h/Jamasp
EnvironmentFile=%h/.config/jamasp/env
ExecStart=/usr/bin/env uv run jamasp authd
Restart=always
RestartSec=2

# Hardening. `full` rather than `strict`: strict makes the whole filesystem
# read-only including /home, and `uv run` writes to the project venv and to
# ~/.cache/uv. `full` covers /usr, /boot and /etc, which is the part worth
# protecting here.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=256M

[Install]
WantedBy=default.target
```

Note `EnvironmentFile` has no `-` prefix, unlike the analyst units: a missing
env file must stop the daemon starting, not start it unconfigured. Starting
unconfigured is the failure mode this whole design is trying to avoid.

The JWKS backstop lives under `~/.local/state/jamasp` rather than
`/var/lib/jamasp` because that directory is root-owned 0755 and this daemon
runs as `jamasp`.

If `uv run` still fails under `ProtectSystem=full`, do not reach for
`ProtectSystem=no` — add the specific path to `ReadWritePaths` and record
which one it was.

- [ ] **Step 2: Commit the unit**

```bash
git add ops/systemd/jamasp-authd.service
git commit -m "ops(authd): systemd unit for the Access JWT sidecar"
```

- [ ] **Step 3: Push, then pull on the host**

```bash
git push
ssh jamasp 'su - jamasp -c "cd ~/Jamasp && git pull --ff-only && uv sync"'
```

Expected: fast-forward, and `uv sync` installs `pyjwt` + `cryptography`.
If `cryptography` fails to build on Python 3.14, stop and report — do not
work around it by pinning.

- [ ] **Step 4: Add the configuration**

Read the existing env file first; this appends, it does not replace.

```bash
ssh jamasp 'su - jamasp -c "cat ~/.config/jamasp/env"'
```

Then append the two values:

```bash
ssh jamasp 'su - jamasp -c "mkdir -p ~/.config/jamasp && cat >> ~/.config/jamasp/env"' <<'EOF'
JAMASP_ACCESS_AUD=b54e2de7426792dfaa6f9134c8c5d01b36491a72e4ed0e3c7f5ac7f812d27264
JAMASP_ACCESS_TEAM_DOMAIN=mahdanian-saman-81.cloudflareaccess.com
EOF
ssh jamasp 'su - jamasp -c "grep -c JAMASP_ACCESS ~/.config/jamasp/env"'
```

Expected: `2`. If it prints more, the append ran twice — dedupe before
continuing, because systemd takes the last assignment and a stale duplicate
above a correct one would be invisible.

If the file did not previously end in a newline, the first appended line will
have been glued onto the last existing one. Check:

```bash
ssh jamasp 'su - jamasp -c "tail -4 ~/.config/jamasp/env"'
```

- [ ] **Step 5: Install and start the unit**

```bash
ssh jamasp 'install -d -o jamasp -g jamasp -m 0755 /home/jamasp/.local/state/jamasp'
ssh jamasp 'sed -e "s|%h|/home/jamasp|g" -e "/^\[Service\]/a User=jamasp" \
  /home/jamasp/Jamasp/ops/systemd/jamasp-authd.service \
  > /etc/systemd/system/jamasp-authd.service'
ssh jamasp 'systemctl daemon-reload && systemctl enable --now jamasp-authd'
ssh jamasp 'systemctl is-active jamasp-authd && journalctl -u jamasp-authd -n 20 --no-pager'
```

Expected: `active`, and a log line `JWKS refreshed: N key(s)` with N ≥ 1.

- [ ] **Step 6: Prove it fetched real Cloudflare keys**

```bash
ssh jamasp 'jq ".keys | length, .keys[0].kid" /home/jamasp/.local/state/jamasp/access-jwks.json'
```

Expected: a count ≥ 1 and a real `kid`. Compare against the live endpoint:

```bash
ssh jamasp 'curl -sS https://mahdanian-saman-81.cloudflareaccess.com/cdn-cgi/access/certs | jq ".keys | length"'
```

The two counts must match.

- [ ] **Step 7: Prove it denies on the host**

```bash
ssh jamasp 'curl -sS -o /dev/null -w "no-header:%{http_code}\n"  http://127.0.0.1:3301/auth'
ssh jamasp 'curl -sS -o /dev/null -w "junk:%{http_code}\n" -H "Cf-Access-Jwt-Assertion: not-a-jwt" http://127.0.0.1:3301/auth'
```

Expected: `no-header:403` and `junk:403`.

- [ ] **Step 8: Prove it is not reachable from outside**

The sidecar must be loopback-only.

```bash
ssh jamasp 'ss -lntp | grep 3301'
```

Expected: bound to `127.0.0.1:3301` only — **not** `0.0.0.0` or `*`.

- [ ] **Step 9: Confirm the panel is untouched**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -I https://jamasp.mahdanian.xyz/
```

Expected: `302` to the Access auth domain, exactly as before this task.

---

### Task 5: Wire nginx, rotate the password, run the matrix

The cutover. This is where behaviour changes.

**Files:**
- Modify: `ops/nginx/jamasp-panel.conf`

**Interfaces:**
- Consumes: the running sidecar from Task 4.
- Produces: `satisfy any` on the panel vhost.

- [ ] **Step 1: Add the auth_request configuration**

In `ops/nginx/jamasp-panel.conf`, in the `server` block for
`jamasp.mahdanian.xyz`, replace these two lines:

```nginx
    auth_basic           "Jamasp";
    auth_basic_user_file /etc/nginx/jamasp.htpasswd;
```

with:

```nginx
    # Either a valid Cloudflare Access JWT or the basic auth password gets
    # you in. In normal browser use the JWT satisfies this and no password
    # is ever requested; basic auth is the fallback for when Access is
    # unavailable, misconfigured, or the sidecar is down.
    satisfy any;
    auth_request         /_access-check;
    auth_basic           "Jamasp";
    auth_basic_user_file /etc/nginx/jamasp.htpasswd;
```

and add these two locations inside the same `server` block, before
`location /`:

```nginx
    # Access JWT validation, via the localhost sidecar (jamasp-authd).
    location = /_access-check {
        internal;
        proxy_pass              http://127.0.0.1:3301/auth;
        proxy_pass_request_body off;
        proxy_set_header        Content-Length "";
        proxy_connect_timeout   1s;
        proxy_read_timeout      2s;

        # Load-bearing. Under `satisfy any` nginx only treats 401 and 403 as
        # "denied, try the next handler". A 5xx — which is what a refused,
        # hung or dead sidecar produces — finalises the request instead,
        # bypassing basic auth and turning "authd is down" into a hard 500
        # for everyone. Map it to a denial so the fallback still runs.
        error_page 500 502 503 504 = @access_denied;
    }

    location @access_denied {
        internal;
        return 403;
    }
```

- [ ] **Step 2: Commit and deploy the config**

```bash
git add ops/nginx/jamasp-panel.conf
git commit -m "ops(nginx): validate the Access JWT via auth_request, basic auth as fallback"
git push
ssh jamasp 'su - jamasp -c "cd ~/Jamasp && git pull --ff-only"'
ssh jamasp 'cp /home/jamasp/Jamasp/ops/nginx/jamasp-panel.conf /etc/nginx/sites-available/jamasp-panel.conf && nginx -t'
```

Expected: `syntax is ok` / `test is successful`. Then:

```bash
ssh jamasp 'systemctl reload nginx && systemctl is-active nginx'
```

- [ ] **Step 3: Rotate the basic auth password**

Record the current ownership and mode first — the rotation must preserve
them, not guess at them:

```bash
ssh jamasp 'stat -c "%U:%G %a" /etc/nginx/jamasp.htpasswd'
```

Generate and install. `htpasswd -i` reads the password from stdin so it never
appears in the process table, and the new file inherits the old file's
ownership and mode via `--reference`:

```bash
NEWPW="$(ssh jamasp 'openssl rand -base64 18 | tr -d "/+=" | cut -c1-24')"
printf '%s\n' "$NEWPW" | ssh jamasp '
  htpasswd -i -c /etc/nginx/jamasp.htpasswd.new desk &&
  chown --reference=/etc/nginx/jamasp.htpasswd /etc/nginx/jamasp.htpasswd.new &&
  chmod --reference=/etc/nginx/jamasp.htpasswd /etc/nginx/jamasp.htpasswd.new &&
  mv /etc/nginx/jamasp.htpasswd.new /etc/nginx/jamasp.htpasswd'
ssh jamasp 'systemctl reload nginx'
```

Verify both directions from the host over loopback. `iif lo accept` in the
nftables ruleset lets these through, and hitting the origin directly means
Cloudflare Access is not in the path — so basic auth is the only thing that
can grant access, which is exactly what needs testing. Set `OLDPW` from the
password manager entry being replaced; **never** write either password into
this repo, a report, or a scratch file that outlives the run:

```bash
ssh jamasp "curl -sS -o /dev/null -w 'old:%{http_code}\n' -u 'desk:$OLDPW' \
  --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/"
ssh jamasp "curl -sS -o /dev/null -w 'new:%{http_code}\n' -u 'desk:$NEWPW' \
  --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/"
```

Expected: `old:401` and `new:200`. An `old:200` means the rotation did not
take effect — check that nginx actually reloaded.

Then hand the new password to the operator once, for their password manager.

- [ ] **Step 3b: Confirm the sidecar is not what let that through**

`new:200` above proves basic auth works. It does not prove the JWT layer is
doing anything — a validator that allowed everything would produce the same
result. Check the negative case now, before moving on:

```bash
ssh jamasp "curl -sS -o /dev/null -w 'no-creds:%{http_code}\n' \
  --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/"
```

Expected: `no-creds:401`. A `200` here means the sidecar is granting access to
an unauthenticated request — the "validator allows everything" failure. Stop
and fix before continuing.

- [ ] **Step 4: Negative test — sidecar stopped must give 401, not 500**

This is the single most important test in this plan. It proves the
`error_page` mapping works and that a dead sidecar does not take the panel
down.

```bash
ssh jamasp 'systemctl stop jamasp-authd
  curl -sS -o /dev/null -w "authd-down:%{http_code}\n" \
    --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/
  curl -sSI --resolve jamasp.mahdanian.xyz:443:127.0.0.1 \
    https://jamasp.mahdanian.xyz/ | grep -i www-authenticate
  systemctl start jamasp-authd'
ssh jamasp 'systemctl is-active jamasp-authd'
```

Both commands run inside a single `ssh` invocation deliberately: the sidecar
must not be left stopped if the connection drops between them.

Expected: `authd-down:401`, plus a `WWW-Authenticate: Basic realm="Jamasp"`
line. A `500` or `502` means the `error_page` mapping is not working — stop,
fix it, and re-run before going further. A 401 *without* the
`WWW-Authenticate` header means a browser will show an error page rather than
prompting, which is the same outage in a different costume.

- [ ] **Step 5: Negative test — hung sidecar must fail fast**

```bash
ssh jamasp 'systemctl kill -s SIGSTOP jamasp-authd
  time curl -sS -o /dev/null -w "authd-hung:%{http_code}\n" \
    --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/
  systemctl kill -s SIGCONT jamasp-authd'
ssh jamasp 'systemctl is-active jamasp-authd'
```

Expected: `authd-hung:401` in roughly 2–3s, not 60s. Anything approaching 60s
means `proxy_connect_timeout`/`proxy_read_timeout` are not taking effect and
a hung sidecar would stall every page load.

- [ ] **Step 6: Positive test — the browser path**

Ask the operator to load `https://jamasp.mahdanian.xyz` in a browser with no
existing session and confirm all four:

1. Cloudflare Access asks for the email PIN.
2. After the PIN, the panel Overview renders.
3. **No basic auth password prompt appears at any point.** This absence is
   the observable proof the JWT path works.
4. SWR polling keeps working — leave the Overview open for a minute and
   confirm it refreshes rather than going blank or erroring. Every `/api/*`
   poll passes through `auth_request` too, so a validator that only worked
   for top-level navigations would surface here.
5. A Server Action round-trips: schedule a wakeup from the panel, then

```bash
ssh jamasp 'su - jamasp -c "cd ~/Jamasp && uv run jamasp wakeup list"'
```

shows it, and cancelling from the panel removes it.

If the browser is already carrying a saved basic auth credential for this
site, point 3 proves nothing — the browser would send it and never be
challenged regardless. Use a private window, or clear the saved credential
first.

- [ ] **Step 7: Confirm the JWT path is what is granting access**

An easy way to be fooled: the browser could be sailing through on a cached
basic auth credential. Check the sidecar actually saw and approved a request:

```bash
ssh jamasp 'journalctl -u jamasp-authd --since "10 min ago" --no-pager | tail -20'
ssh jamasp 'grep -c " 200 " /var/log/nginx/jamasp-panel.access.log'
```

Then prove it directly — a request with a deliberately corrupted JWT and no
basic auth must be challenged, while the same request in the browser is not:

```bash
ssh jamasp 'curl -sS -o /dev/null -w "bad-jwt:%{http_code}\n" \
  -H "Cf-Access-Jwt-Assertion: eyJhbGciOiJSUzI1NiIsImtpZCI6Im5vcGUifQ.e30.x" \
  --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/'
```

Expected: `bad-jwt:401`.

The strongest available check that signature verification is real against the
*live* configuration: take a genuine JWT from the browser session (the
`CF_Authorization` cookie), flip one character in its signature segment, and
send that. It must give 401 while the unmodified token gives 200.

```bash
# GOOD=<the CF_Authorization cookie value from the browser>
ssh jamasp "curl -sS -o /dev/null -w 'real-jwt:%{http_code}\n' \
  -H 'Cf-Access-Jwt-Assertion: $GOOD' \
  --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/"
ssh jamasp "curl -sS -o /dev/null -w 'tampered-jwt:%{http_code}\n' \
  -H 'Cf-Access-Jwt-Assertion: ${GOOD%?}X' \
  --resolve jamasp.mahdanian.xyz:443:127.0.0.1 https://jamasp.mahdanian.xyz/"
```

Expected: `real-jwt:200` and `tampered-jwt:401`. That pair is the end-to-end
equivalent of the wrong-key unit test, run against the deployed system.

Treat the token as a live credential: it grants panel access until it
expires. Keep it in a shell variable, never in a file or a commit.

- [ ] **Step 8: Confirm nothing else regressed**

```bash
ssh jamasp 'systemctl is-active jamasp-authd nginx jamasp-panel jamasp-edge'
ssh jamasp 'systemctl list-timers "jamasp-*" --no-pager'
```

Expected: all four active; six analyst timers still scheduled.

And the escape hatch still bypasses nginx entirely:

```bash
ssh -N -L 3300:127.0.0.1:3300 jamasp &
sleep 2 && curl -sS -o /dev/null -w "tunnel:%{http_code}\n" http://127.0.0.1:3300/
kill %1
```

Expected: `tunnel:200`.

---

### Task 6: Documentation

**Files:**
- Modify: `.claude/skills/deploy/SKILL.md`
- Modify: `.claude/skills/access-whitelist/SKILL.md`
- Modify: `docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md`

- [ ] **Step 1: Add the sidecar to the deploy runbook**

In `.claude/skills/deploy/SKILL.md`, under the existing "Public access"
section, add a subsection covering:

- The unit (`ops/systemd/jamasp-authd.service`), that it installs through the
  ordinary `ops/systemd/` loop, and that `~/.local/state/jamasp` must exist
  and be owned by `jamasp` before first start.
- The two required env vars in `~/.config/jamasp/env`, and that the daemon
  **refuses to start** without them — the first thing to check when the panel
  starts prompting for a password unexpectedly.
- Why the unit uses `ProtectSystem=full` and not `strict`: `strict` makes
  /home read-only and `uv run` needs to write to the venv and `~/.cache/uv`.
- The `error_page` trap, verbatim:

> **Trap: the `error_page 500 502 503 504 = @access_denied` mapping in the
> `/_access-check` location is load-bearing.** nginx's `satisfy any` treats
> only 401 and 403 as "this handler denied, try the next one". Any 5xx —
> which is exactly what a refused, hung, or dead `jamasp-authd` produces —
> finalises the request instead, skipping basic auth entirely. Without that
> mapping, "the sidecar is down" becomes a hard 500 for everyone including
> someone typing the correct password, which is the lockout the basic auth
> fallback exists to prevent. Do not remove it when tidying the config.
> Verify with `systemctl stop jamasp-authd` and expect **401**, not 500;
> restart it in the same `ssh` invocation so a dropped connection cannot
> leave it stopped.

- The diagnostic table below.

| Symptom | Likely cause | Check |
|---|---|---|
| Password prompt where there was none | sidecar down, or JWKS stale | `systemctl status jamasp-authd`, `journalctl -u jamasp-authd` |
| Hard 500 instead of a prompt | `error_page` mapping lost from the check location | `grep -A2 access_denied /etc/nginx/sites-available/jamasp-panel.conf` |
| Sidecar won't start | env vars missing from `~/.config/jamasp/env` | `grep JAMASP_ACCESS ~/.config/jamasp/env` |
| Every request 403 at the sidecar | AUD mismatch after recreating the Access app | compare `JAMASP_ACCESS_AUD` against the app's AUD tag |
| Panel reachable with no auth at all | `satisfy any` present but both checks passing wrongly | `curl -I` from the host; expect 302 or 401, never 200 |

- [ ] **Step 2: Correct the access-whitelist skill**

Two things there are now wrong. In `.claude/skills/access-whitelist/SKILL.md`:

Replace the layer table row:

```
| nginx basic auth | Fallback credential, user `desk` |
```

with:

```
| nginx basic auth | Fallback only — used when the Access JWT is absent or unverifiable |
```

And replace this paragraph:

```
Adding someone here is **not** enough on its own: they also need the basic
auth password (in the operator's password manager). Both are required until
the Access-JWT work in
`docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md` lands.
```

with:

```
Adding someone here **is** enough. Since the Access-JWT work landed, a
browser session that clears Access is admitted by the origin on its JWT
alone — no password to hand over. The basic auth credential remains as an
operator fallback for when the JWT path is unavailable; it is not part of
granting someone access.
```

- [ ] **Step 3: Close out the spec**

Change the header of
`docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md`:

```
**Status:** Implemented 2026-08-09 — see the plan for what was verified
```

Add a short "What was observed" section at the end recording the actual
results of Task 5 steps 4–7: the `authd-down` status code, the hung-sidecar
timing, and whether the browser saw a password prompt. Record what actually
happened, including anything that did not match the design.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/deploy/SKILL.md .claude/skills/access-whitelist/SKILL.md \
  docs/superpowers/specs/2026-08-09-access-jwt-origin-auth-design.md
git commit -m "docs: runbook and skill updates for the Access JWT sidecar"
git push
```

---

## Rollback

Cheap and complete at every point.

- **After Task 4:** `systemctl disable --now jamasp-authd`. nginx never knew
  about it; nothing user-visible was changed.
- **After Task 5:** revert the two `ops/nginx/jamasp-panel.conf` hunks (drop
  `satisfy any`, `auth_request`, and both locations), copy the file back to
  `/etc/nginx/sites-available/`, `nginx -t && systemctl reload nginx`. The
  panel returns to basic-auth-only in under a minute.
- **Throughout:** the SSH tunnel to `127.0.0.1:3300` bypasses nginx entirely
  and is unaffected by anything in this plan.
