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
        if not token:
            # Denied here rather than delegated. AccessVerifier already
            # rejects an empty token, but this endpoint's contract — no
            # header means no — should not depend on that.
            self._respond(403)
            return

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
