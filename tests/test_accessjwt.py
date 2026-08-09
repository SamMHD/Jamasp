import json
import time

import httpx
from cryptography.hazmat.primitives.asymmetric import rsa

from jamasp.accessjwt import AccessVerifier, JwksCache


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


def test_empty_audience_is_refused_at_construction(tmp_path):
    """A misconfigured verifier must not silently accept every team's tokens."""
    import pytest

    key = _keypair()
    cache = JwksCache(
        "https://example.test/certs",
        tmp_path / "jwks.json",
        transport=_transport(_jwks_dict(key)),
    )
    with pytest.raises(ValueError):
        AccessVerifier(cache, audience="", issuer=ISS)
    with pytest.raises(ValueError):
        AccessVerifier(cache, audience=AUD, issuer="")
