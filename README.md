# Jamasp — جاماسپ

Autonomous gold-market analyst for the desk. Spec:
`docs/superpowers/specs/2026-07-31-jamasp-design.md`.

## Setup

    uv sync
    export JAMASP_TG_TOKEN=<botfather token>
    export JAMASP_TG_CHAT=<chat id>

## Daily run (phase 1: manual, on the Mac)

    uv run jamasp ingest        # any time; safe to run repeatedly
    claude "/brief"             # the morning brief (Dubai morning)

Gold price is tracked via COMEX GC=F futures (a standard spot-gold proxy, since
the underlying feed sits behind a Cloudflare bot challenge).

Outputs: `reports/YYYY/MM/YYYY-MM-DD-brief.md` + Persian Telegram summary.

## Useful commands

    uv run jamasp inbox           # what the agent will see
    uv run jamasp price           # latest snapshots + deltas
    uv run jamasp sources check   # feed health
    uv run pytest                 # test suite

## Phase status

Phase 1 (MVP) — manual daily runs. Wakeup queue, /scan, /deepdive, retros,
VPS deployment: phase 2 (see spec roadmap).
