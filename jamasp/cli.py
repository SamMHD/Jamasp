"""jamasp CLI — the agent's toolbox and the operator's ops tool."""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import click
import httpx

from jamasp import authd as authd_mod
from jamasp import calendarview as calendarview_mod
from jamasp import cluster as cluster_mod
from jamasp import db as db_mod
from jamasp import digest as digest_mod
from jamasp import dispatch as dispatch_mod
from jamasp import extract as extract_mod
from jamasp import flash as flash_mod
from jamasp import inbox as inbox_mod
from jamasp import notify as notify_mod
from jamasp import predictions as predictions_mod
from jamasp import pricesummary as pricesummary_mod
from jamasp import runner as runner_mod
from jamasp import wakeup as wakeup_mod
from jamasp import watchdog as watchdog_mod
from jamasp.config import load_settings, load_sources
from jamasp.ingest import calendar as calendar_mod
from jamasp.ingest import prices as prices_mod
from jamasp.ingest import rss as rss_mod


def _common(db_path: str, config_dir: str):
    cfg = Path(config_dir)
    conn = db_mod.connect(Path(db_path))
    sources = load_sources(cfg / "sources.yaml")
    settings = load_settings(cfg / "settings.yaml")
    return conn, sources, settings


db_opt = click.option("--db", "db_path", default="state/jamasp.db", show_default=True)
cfg_opt = click.option("--config-dir", default="config", show_default=True)

# The ingest timer fires every 15 minutes; without slack a 15-minute source
# would miss its own tick whenever the timer lands a second early.
_REFETCH_SLACK_SECONDS = 60


def _refetch_due(last: str, interval_minutes: int, now: str) -> bool:
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    elapsed = (datetime.strptime(now, fmt) - datetime.strptime(last, fmt)).total_seconds()
    return elapsed >= interval_minutes * 60 - _REFETCH_SLACK_SECONDS


@click.group()
def main():
    """Jamasp toolbox: deterministic ingestion + compact agent-facing views."""


@main.command()
@click.option("--no-digest", is_flag=True, help="skip the haiku lede pass")
@click.option("--no-flash", is_flag=True, help="skip the telegram news flash pass")
@db_opt
@cfg_opt
def ingest(no_digest, no_flash, db_path, config_dir):
    """Fetch all sources, dedupe, cluster, and (optionally) write ledes."""
    conn, sources, settings = _common(db_path, config_dir)
    new_items = prices_n = events_n = errors = skipped = 0
    with httpx.Client(headers={"User-Agent": "jamasp/0.1"}) as client:
        for source in sources:
            last = db_mod.get_meta(conn, f"source_last_fetch.{source.name}")
            if last and not _refetch_due(last, source.interval_minutes, db_mod.utcnow()):
                skipped += 1
                continue
            try:
                if source.type == "rss":
                    new_items += rss_mod.store_items(
                        conn, rss_mod.fetch_source(source, client)
                    )
                elif source.type == "price_api":
                    symbol, ts, value = prices_mod.fetch_price(source, client)
                    prices_mod.store_price(conn, symbol, ts, value)
                    prices_n += 1
                elif source.type == "technicals_api":
                    for symbol, ts, value in prices_mod.fetch_technicals(source, client):
                        prices_mod.store_price(conn, symbol, ts, value)
                    prices_n += 1
                elif source.type == "calendar":
                    events_n += calendar_mod.store_events(
                        conn, calendar_mod.fetch_source(source, client)
                    )
                # only a successful fetch advances the interval clock; failures
                # retry on the next timer tick
                db_mod.set_meta(
                    conn, f"source_last_fetch.{source.name}", db_mod.utcnow()
                )
            except Exception as exc:  # per-source isolation, by design
                errors += 1
                conn.execute(
                    "INSERT INTO source_errors (source, ts, error) VALUES (?, ?, ?)",
                    (source.name, db_mod.utcnow(), str(exc)[:500]),
                )
                conn.commit()
                click.echo(f"WARN {source.name}: {exc}", err=True)
    ccfg = settings["cluster"]
    joined = cluster_mod.assign_clusters(
        conn, ccfg["similarity_threshold"], ccfg["window_hours"]
    )
    ledes = 0 if no_digest else digest_mod.run_digest(conn, settings)
    # Sources are fetched and committed by here, so the heartbeat is already
    # true — the watchdog must not wait out the flash pass to see it.
    db_mod.set_meta(conn, "last_ingest_at", db_mod.utcnow())
    flashes = {}
    if not no_flash:
        flashes = flash_mod.run_flash(conn, settings, sources)
    click.echo(
        f"ingest: {new_items} new items ({joined} clustered), "
        f"{prices_n} price snapshots, {events_n} events, {ledes} ledes, "
        f"{errors} source errors, {skipped} within interval"
    )
    if flashes:
        click.echo(_flash_line(flashes))


@main.command()
@click.option("--mark-read", is_flag=True)
@click.option("--cap", type=int, default=None)
@db_opt
@cfg_opt
def inbox(mark_read, cap, db_path, config_dir):
    """Print unread items as compact JSONL (the agent's news delta)."""
    conn, _, settings = _common(db_path, config_dir)
    if mark_read:
        click.echo(f"marked {inbox_mod.mark_read(conn)} items read")
        return
    click.echo(inbox_mod.render(conn, cap or settings["inbox_cap"]))


@main.command()
@click.argument("url")
@click.option("--fresh", is_flag=True, help="ignore any cached copy and re-fetch")
@db_opt
@cfg_opt
def extract(url, fresh, db_path, config_dir):
    """Print readability-extracted article text (cached, truncated).

    The first line carries the extract's `fetched_at` and age, so a stale
    index-page snapshot can't be read as the live tape.
    """
    conn, _, settings = _common(db_path, config_dir)
    max_age = 0 if fresh else settings.get("extract_max_age_hours", 6)
    text = extract_mod.extract_url(
        conn, url, settings["extract_max_chars"], max_age_hours=max_age
    )
    fetched_at = extract_mod.cached_at(conn, url)
    age = extract_mod._age_hours(fetched_at, db_mod.utcnow())
    click.echo(f"# extract {url} — fetched_at {fetched_at} ({age:.1f}h ago)")
    click.echo(text)


def _flash_line(stats: dict) -> str:
    """One-line flash summary, shared by `ingest` and `flash`."""
    return (
        f"flash: {stats['posted']} posted, {stats.get('held', 0)} held, "
        f"{stats.get('low_tier', 0)} low tier, {stats.get('no_tier', 0)} no tier, "
        f"{stats['dup']} updated, "
        f"{stats['not_gold']} not gold, {stats['unreadable']} unreadable, "
        f"{stats['burst']} over cap, {stats['stale']} stale, "
        f"{stats.get('born_old', 0)} born old, "
        f"{stats.get('skipped_locked', 0)} skipped (locked), "
        f"{stats['errors']} errors"
    )


@main.command()
@click.option("--dry-run", is_flag=True, help="render messages; send and store nothing")
@db_opt
@cfg_opt
def flash(dry_run, db_path, config_dir):
    """Publish new gold items to the Telegram news channel (one pass)."""
    conn, sources, settings = _common(db_path, config_dir)
    stats = flash_mod.run_flash(
        conn, settings, sources, emit=click.echo, dry_run=dry_run
    )
    click.echo(_flash_line(stats))


@main.command("flash-rollup")
@click.option("--dry-run", is_flag=True, help="render the rollup; send nothing")
@db_opt
@cfg_opt
def flash_rollup(dry_run, db_path, config_dir):
    """Send one roundup of held middle-tier stories to the news channel.

    Driven by its own timer at fixed Dubai times, not by ingest: the flash pass
    runs every 15 minutes and a rollup every few hours.
    """
    conn, _, settings = _common(db_path, config_dir)
    stats = flash_mod.run_rollup(
        conn, settings, emit=click.echo, dry_run=dry_run
    )
    click.echo(
        f"rollup: {stats['items']} items, {stats['sent']} sent, "
        f"{stats['carried']} carried, "
        f"{stats['below_floor']} below floor, "
        f"{stats.get('skipped_locked', 0)} skipped (locked), "
        f"{stats['errors']} errors"
    )


@main.command()
@click.argument("text")
@click.option("--dry-run", is_flag=True)
@db_opt
@cfg_opt
def notify(text, dry_run, db_path, config_dir):
    """Send TEXT (or '-' for stdin) to the Telegram chat."""
    conn, _, settings = _common(db_path, config_dir)
    if text == "-":
        text = sys.stdin.read()
    try:
        msg = notify_mod.notify(text, settings, dry_run=dry_run)
    except Exception:
        if not dry_run:
            notify_mod.log_sent(conn, text, ok=False)
        raise
    if not dry_run:
        notify_mod.log_sent(conn, text, ok=True)
    click.echo(msg)


@main.group()
def sources():
    """Source management."""


@sources.command("check")
@db_opt
@cfg_opt
def sources_check(db_path, config_dir):
    """Fetch every configured source once and report health."""
    _, source_list, _ = _common(db_path, config_dir)
    with httpx.Client(headers={"User-Agent": "jamasp/0.1"}) as client:
        for source in source_list:
            try:
                if source.type == "rss":
                    n = len(rss_mod.fetch_source(source, client))
                    click.echo(f"OK   {source.name} ({n} items)")
                elif source.type == "price_api":
                    symbol, ts, value = prices_mod.fetch_price(source, client)
                    click.echo(f"OK   {source.name} ({symbol}={value} @ {ts})")
                elif source.type == "technicals_api":
                    rows = prices_mod.fetch_technicals(source, client)
                    click.echo(f"OK   {source.name} ({len(rows)} technicals @ {rows[0][1]})")
                elif source.type == "calendar":
                    n = len(calendar_mod.fetch_source(source, client))
                    click.echo(f"OK   {source.name} ({n} events)")
            except Exception as exc:
                click.echo(f"FAIL {source.name}: {exc}")


@main.group("wakeup")
def wakeup_group():
    """Wakeup queue: schedule future agent runs."""


@wakeup_group.command("add")
@click.argument("due_at")
@click.argument("run_type")
@click.argument("task")
@db_opt
@cfg_opt
def wakeup_add(due_at, run_type, task, db_path, config_dir):
    """Schedule RUN_TYPE at DUE_AT (ISO-8601 with timezone) carrying TASK text."""
    conn, _, _ = _common(db_path, config_dir)
    try:
        wid = wakeup_mod.add(conn, due_at, run_type, task)
    except ValueError as exc:
        raise click.BadParameter(str(exc))
    row = conn.execute("SELECT due_at FROM wakeups WHERE id = ?", (wid,)).fetchone()
    click.echo(f"scheduled wakeup #{wid}: {run_type} at {row['due_at']}")


@wakeup_group.command("list")
@db_opt
@cfg_opt
def wakeup_list(db_path, config_dir):
    """List pending wakeups, soonest first."""
    conn, _, _ = _common(db_path, config_dir)
    rows = wakeup_mod.list_open(conn)
    if not rows:
        click.echo("no pending wakeups")
        return
    for r in rows:
        click.echo(f"#{r['id']}  {r['due_at']}  {r['run_type']}  attempts={r['attempts']}  {r['task']}")


@wakeup_group.command("cancel")
@click.argument("wakeup_id", type=int)
@db_opt
@cfg_opt
def wakeup_cancel(wakeup_id, db_path, config_dir):
    """Cancel a wakeup that has not yet fired.

    Only affects wakeups still in 'pending' status. Cannot stop a run
    already in progress — once the dispatcher picks a wakeup up, cancelling
    it here has no effect on that run.
    """
    conn, _, _ = _common(db_path, config_dir)
    try:
        wakeup_mod.cancel(conn, wakeup_id)
    except ValueError as exc:
        raise click.ClickException(str(exc))
    click.echo(f"cancelled wakeup #{wakeup_id}")


@main.command()
@click.option("--dry-run", is_flag=True, help="show what would fire; fire nothing")
@db_opt
@cfg_opt
def dispatch(dry_run, db_path, config_dir):
    """Fire due wakeup-queue entries as headless agent runs."""
    conn, _, settings = _common(db_path, config_dir)
    if dry_run:
        for w in wakeup_mod.due(conn):  # wakeup_mod imported in Task 2
            click.echo(f"[dry-run] would fire #{w['id']} {w['run_type']}: {w['task']}")
        return
    results = dispatch_mod.run_due(conn, settings)
    if not results:
        click.echo("no due wakeups")
        return
    for wid, status in results:
        click.echo(f"wakeup #{wid}: {status}")


@main.command()
@db_opt
@cfg_opt
def price(db_path, config_dir):
    """Print latest snapshots with 24h/7d deltas."""
    conn, _, _ = _common(db_path, config_dir)
    click.echo(pricesummary_mod.render(conn))


@main.command()
@click.option("--reports-dir", default="reports", show_default=True)
@db_opt
@cfg_opt
def watchdog(reports_dir, db_path, config_dir):
    """Health check: ingestion fresh, yesterday's brief exists, queue draining."""
    conn, _, settings = _common(db_path, config_dir)
    violations = watchdog_mod.run(conn, settings, Path(reports_dir))
    if not violations:
        click.echo("OK")
    else:
        for v in violations:
            click.echo(f"VIOLATION: {v}")


@main.command()
@click.option("--days", type=int, default=14, show_default=True)
@click.option("--all-impacts", is_flag=True, help="include Low/Holiday impact rows")
@db_opt
@cfg_opt
def calendar(days, all_impacts, db_path, config_dir):
    """Print upcoming economic-calendar events (JSONL, UTC + Dubai times)."""
    conn, _, _ = _common(db_path, config_dir)
    click.echo(calendarview_mod.render(
        conn, days=days, impact_min="all" if all_impacts else "default"
    ))


@main.command("run")
@click.argument("run_type", type=click.Choice(["brief", "scan", "deepdive", "retro"]))
@click.argument("task", required=False, default=None)
@click.option("--dry-run", is_flag=True, help="print the command; don't execute or record")
@db_opt
@cfg_opt
def run_cmd(run_type, task, dry_run, db_path, config_dir):
    """Fire one wrapped agent run (cap, timeout, retry, failure notice)."""
    conn, _, settings = _common(db_path, config_dir)
    if dry_run:
        prompt = f"/{run_type} {task}" if task else f"/{run_type}"
        click.echo(f"[dry-run] would run: {' '.join(settings['runs']['claude_cmd'])} {prompt!r}")
        return
    status = runner_mod.run_agent(conn, settings, run_type, task=task)
    click.echo(f"{run_type}: {status}")
    if status in ("failed", "timeout"):
        raise SystemExit(1)


pred_path_opt = click.option(
    "--path", "pred_path", default="state/predictions.jsonl", show_default=True
)


@main.group("predictions")
def predictions_group():
    """Structured forecast ledger (add, list, due, score)."""


@predictions_group.command("add")
@click.argument("claim")
@click.option("--direction", type=click.Choice(["up", "down", "flat"]), required=True)
@click.option("--horizon-days", type=int, required=True)
@click.option("--confidence", type=float, required=True)
@pred_path_opt
@db_opt
@cfg_opt
def predictions_add(claim, direction, horizon_days, confidence, pred_path, db_path, config_dir):
    """Record a falsifiable claim with direction, horizon, and confidence."""
    try:
        e = predictions_mod.add(Path(pred_path), claim, direction, horizon_days, confidence)
    except ValueError as exc:
        raise click.BadParameter(str(exc))
    click.echo(f"recorded prediction {e['id']}: {claim}")


@predictions_group.command("list")
@pred_path_opt
@db_opt
@cfg_opt
def predictions_list(pred_path, db_path, config_dir):
    """Print every ledger entry as JSONL."""
    for e in predictions_mod.load(Path(pred_path)):
        click.echo(json.dumps(e, ensure_ascii=False))


@predictions_group.command("due")
@click.option(
    "--open", "include_open", is_flag=True,
    help="also list still-running claims (for checking a live level's status)",
)
@pred_path_opt
@db_opt
@cfg_opt
def predictions_due(include_open, pred_path, db_path, config_dir):
    """Matured, unscored predictions annotated with the actual price move.

    Every entry carries `window_high`/`window_low` over the claim's window,
    which is what settles a level claim — endpoints miss an overnight touch.
    """
    conn, _, settings = _common(db_path, config_dir)
    symbol = settings.get("predictions", {}).get("price_symbol", "GC")
    click.echo(
        predictions_mod.render_due(
            conn, Path(pred_path), symbol, include_open=include_open
        )
    )


@predictions_group.command("score")
@click.argument("pred_id")
@click.option("--outcome", type=click.Choice(["hit", "miss", "unclear"]), required=True)
@click.option("--note", default=None)
@pred_path_opt
@db_opt
@cfg_opt
def predictions_score(pred_id, outcome, note, pred_path, db_path, config_dir):
    """Mark a matured prediction hit/miss/unclear (with a why note)."""
    try:
        e = predictions_mod.score(Path(pred_path), pred_id, outcome, note=note)
    except (KeyError, ValueError) as exc:
        raise click.ClickException(str(exc))
    click.echo(f"scored {e['id']} {outcome}: {e['claim']}")


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

    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(name)s: %(message)s"
    )

    audience = os.environ.get("JAMASP_ACCESS_AUD", "").strip()
    team_domain = os.environ.get("JAMASP_ACCESS_TEAM_DOMAIN", "").strip()
    if not audience or not team_domain:
        # Fail closed and loudly. Defaulting the audience to empty would skip
        # the check that pins a token to THIS application, accepting any
        # Access token from any Cloudflare team.
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


@main.command("alert")
@click.argument("unit")
@click.option("--dry-run", is_flag=True, help="print the message instead of sending")
@db_opt
@cfg_opt
def alert_cmd(unit, dry_run, db_path, config_dir):
    """Send a Telegram alert that systemd UNIT failed (OnFailure= target)."""
    from jamasp import alert as alert_mod

    settings = load_settings(Path(config_dir) / "settings.yaml")
    text = alert_mod.compose(unit, alert_mod.gather(unit))
    if dry_run:
        click.echo(text)
        return

    conn = db_mod.connect(Path(db_path))
    if not alert_mod.should_send(conn, unit):
        click.echo(f"suppressed: {unit} already alerted within the window")
        return

    # Deliberately not runner._notify_safe here. That swallows the failure so
    # a run can survive a Telegram hiccup — right for a brief, wrong for the
    # alerter, whose entire job is delivery. jamasp-alert@.service carries no
    # OnFailure= of its own (that would loop), so exiting non-zero is what
    # puts a broken alerter into `systemctl --failed` instead of leaving
    # nobody to notice that alerting itself stopped working.
    ok = True
    try:
        notify_mod.notify(text, settings)
    except Exception as exc:
        ok = False
        click.echo(f"alert send FAILED for {unit}: {exc}", err=True)
    try:
        notify_mod.log_sent(conn, text, ok)
    except Exception:
        pass

    if not ok:
        raise SystemExit(1)
    click.echo(f"alerted for {unit}")
