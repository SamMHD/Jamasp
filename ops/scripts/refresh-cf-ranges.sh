#!/usr/bin/env bash
# Refresh the Cloudflare source ranges used by the origin lockdown (nftables
# sets) and by nginx real-IP restoration.
#
# Fails CLOSED onto the previous ranges. That claim only holds if a
# "previous" ruleset actually exists: ops/nftables/jamasp-edge.nft recreates
# its sets EMPTY on every load (a `table`/`delete table` pair for idempotent
# reloads), and jamasp-edge.service runs that reload immediately before this
# script on every boot. So at boot there is no live ruleset to fall back to
# — an in-memory-only fallback would black-hole the panel behind an
# all-drop rule until the next successful refresh, up to a full timer
# period later. To make "fails closed onto the previous ranges" true even
# at boot, every successful run also caches the accepted lists to disk
# ($CACHE_V4 / $CACHE_V6); on failure, if a cache exists, it gets loaded
# into the live nftables sets before this script still exits non-zero (so
# the failure stays visible in `systemctl status`). An empty set would drop
# Cloudflare itself and take the panel offline; stale ranges are always the
# safer state.
set -euo pipefail

V4_URL="https://www.cloudflare.com/ips-v4"
V6_URL="https://www.cloudflare.com/ips-v6"
MIN_V4=10
MIN_V6=5
NFT_TABLE="inet jamasp_edge"
NGINX_SNIPPET="/etc/nginx/conf.d/cloudflare-real-ip.conf"
CACHE_DIR="/var/lib/jamasp"
CACHE_V4="$CACHE_DIR/cf-ranges.v4"
CACHE_V6="$CACHE_DIR/cf-ranges.v6"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Number of CIDRs currently loaded in nft set $1 (cf_v4 / cf_v6). A missing
# table (e.g. first-ever boot, or right after the unconditional reload at
# the top of jamasp-edge.service) is treated as zero rather than an error —
# `|| true` absorbs both the "no such table" failure from `nft list set`
# and grep's "no matches" exit status under `set -o pipefail`, without
# discarding the count that `wc -l` already wrote to stdout.
current_count() {
    local n
    n="$(nft list set $NFT_TABLE "$1" 2>/dev/null | grep -o '/[0-9]\+' | wc -l || true)"
    echo "${n:-0}"
}

# Load the cached last-known-good ranges into the live nftables sets. Used
# both as the boot-time fallback (sets start empty) and as the failure
# fallback thereafter. Idempotent and harmless even when the sets already
# hold current data, since it's the same replace-in-one-transaction shape
# as the normal success path.
load_cache_into_sets() {
    if [ -s "$CACHE_V4" ] && [ -s "$CACHE_V6" ]; then
        {
            echo "flush set $NFT_TABLE cf_v4"
            echo "flush set $NFT_TABLE cf_v6"
            echo "add element $NFT_TABLE cf_v4 { $(paste -sd, "$CACHE_V4") }"
            echo "add element $NFT_TABLE cf_v6 { $(paste -sd, "$CACHE_V6") }"
        } | nft -f -
        echo "refresh-cf-ranges: loaded cached ranges (v4=$(wc -l < "$CACHE_V4") v6=$(wc -l < "$CACHE_V6")) after failure" >&2
        return 0
    fi
    return 1
}

# Common failure path: log, try the cache, always exit non-zero so the
# failure stays visible (systemctl status / journalctl), whether or not a
# cache was available to fall back onto.
fail() {
    echo "refresh-cf-ranges: $1 — falling back to cached ranges" >&2
    if load_cache_into_sets; then
        exit 1
    fi
    echo "refresh-cf-ranges: no cache at $CACHE_DIR yet — cannot recover, sets may be left empty" >&2
    exit 1
}

if ! curl -fsS --max-time 20 "$V4_URL" -o "$tmp/v4"; then
    fail "fetch of $V4_URL failed"
fi
if ! curl -fsS --max-time 20 "$V6_URL" -o "$tmp/v6"; then
    fail "fetch of $V6_URL failed"
fi

# Keep only well-formed CIDRs — guards against error pages and truncation.
grep -Ex '[0-9.]+/[0-9]+'       "$tmp/v4" > "$tmp/v4.clean" || true
grep -Ex '[0-9a-fA-F:]+/[0-9]+' "$tmp/v6" > "$tmp/v6.clean" || true

v4n="$(wc -l < "$tmp/v4.clean")"
v6n="$(wc -l < "$tmp/v6.clean")"
if [ "$v4n" -lt "$MIN_V4" ] || [ "$v6n" -lt "$MIN_V6" ]; then
    fail "implausible list (v4=$v4n v6=$v6n, floors are v4>=$MIN_V4 v6>=$MIN_V6)"
fi

# Relative guard, in addition to the absolute floors above: a fetch that
# clears MIN_V4/MIN_V6 but still returns fewer CIDRs than are already live
# would silently drop real Cloudflare ranges (partial edge blocked,
# intermittent 522s). Compare against what's actually loaded right now, not
# a remembered count, and treat "no table yet" as zero so a first-ever run
# isn't rejected against nothing.
cur_v4="$(current_count cf_v4)"
cur_v6="$(current_count cf_v6)"
if [ "$v4n" -lt "$cur_v4" ] || [ "$v6n" -lt "$cur_v6" ]; then
    fail "fetched list smaller than currently loaded (v4 $v4n<$cur_v4 or v6 $v6n<$cur_v6)"
fi

# nftables: replace both sets in one atomic transaction.
{
    echo "flush set $NFT_TABLE cf_v4"
    echo "flush set $NFT_TABLE cf_v6"
    echo "add element $NFT_TABLE cf_v4 { $(paste -sd, "$tmp/v4.clean") }"
    echo "add element $NFT_TABLE cf_v6 { $(paste -sd, "$tmp/v6.clean") }"
} > "$tmp/sets.nft"
nft -f "$tmp/sets.nft"

# Cache the accepted lists so a future failure (including at next boot) has
# something better than "empty" to fall back onto.
install -d -m 0755 "$CACHE_DIR"
install -m 0644 "$tmp/v4.clean" "$CACHE_V4"
install -m 0644 "$tmp/v6.clean" "$CACHE_V6"

# nginx real-IP snippet — only once nginx is actually installed.
if command -v nginx >/dev/null 2>&1 && [ -d /etc/nginx/conf.d ]; then
    {
        echo "# Generated by refresh-cf-ranges.sh — do not edit by hand."
        sed 's|^|set_real_ip_from |; s|$|;|' "$tmp/v4.clean"
        sed 's|^|set_real_ip_from |; s|$|;|' "$tmp/v6.clean"
        echo "real_ip_header CF-Connecting-IP;"
        echo "real_ip_recursive on;"
    } > "$tmp/real-ip.conf"

    if ! cmp -s "$tmp/real-ip.conf" "$NGINX_SNIPPET"; then
        install -m 0644 "$tmp/real-ip.conf" "$NGINX_SNIPPET"
        nginx -t && systemctl reload nginx
    fi
fi

echo "refresh-cf-ranges: ok (v4=$v4n v6=$v6n)"
