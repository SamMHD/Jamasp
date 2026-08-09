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
