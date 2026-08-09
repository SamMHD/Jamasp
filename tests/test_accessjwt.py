import json
import time

import httpx
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
