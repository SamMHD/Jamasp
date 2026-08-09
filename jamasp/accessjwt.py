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
                # A kid we have never seen is the signature of a rotation
                # that happened inside the TTL window. One forced refresh,
                # then give up until the next natural expiry — otherwise a
                # stream of junk kids becomes a fetch per request.
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
