"""jamasp CLI — the agent's toolbox and the operator's ops tool."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import click
import httpx

from jamasp import calendarview as calendarview_mod
from jamasp import cluster as cluster_mod
from jamasp import db as db_mod
from jamasp import digest as digest_mod
from jamasp import extract as extract_mod
from jamasp import inbox as inbox_mod
from jamasp import notify as notify_mod
from jamasp import predictions as predictions_mod
from jamasp import pricesummary as pricesummary_mod
from jamasp import wakeup as wakeup_mod
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


@click.group()
def main():
    """Jamasp toolbox: deterministic ingestion + compact agent-facing views."""


@main.command()
@click.option("--no-digest", is_flag=True, help="skip the haiku lede pass")
@db_opt
@cfg_opt
def ingest(no_digest, db_path, config_dir):
    """Fetch all sources, dedupe, cluster, and (optionally) write ledes."""
    conn, sources, settings = _common(db_path, config_dir)
    new_items = prices_n = events_n = errors = 0
    with httpx.Client(headers={"User-Agent": "jamasp/0.1"}) as client:
        for source in sources:
            try:
                if source.type == "rss":
                    new_items += rss_mod.store_items(
                        conn, rss_mod.fetch_source(source, client)
                    )
                elif source.type == "price_api":
                    symbol, ts, value = prices_mod.fetch_price(source, client)
                    prices_mod.store_price(conn, symbol, ts, value)
                    prices_n += 1
                elif source.type == "calendar":
                    events_n += calendar_mod.store_events(
                        conn, calendar_mod.fetch_source(source, client)
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
    db_mod.set_meta(conn, "last_ingest_at", db_mod.utcnow())
    click.echo(
        f"ingest: {new_items} new items ({joined} clustered), "
        f"{prices_n} price snapshots, {events_n} events, {ledes} ledes, {errors} source errors"
    )


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
@db_opt
@cfg_opt
def extract(url, db_path, config_dir):
    """Print readability-extracted article text (cached, truncated)."""
    conn, _, settings = _common(db_path, config_dir)
    click.echo(extract_mod.extract_url(conn, url, settings["extract_max_chars"]))


@main.command()
@click.argument("text")
@click.option("--dry-run", is_flag=True)
@db_opt
@cfg_opt
def notify(text, dry_run, db_path, config_dir):
    """Send TEXT (or '-' for stdin) to the Telegram chat."""
    _, _, settings = _common(db_path, config_dir)
    if text == "-":
        text = sys.stdin.read()
    click.echo(notify_mod.notify(text, settings, dry_run=dry_run))


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


@main.command()
@db_opt
@cfg_opt
def price(db_path, config_dir):
    """Print latest snapshots with 24h/7d deltas."""
    conn, _, _ = _common(db_path, config_dir)
    click.echo(pricesummary_mod.render(conn))


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
@pred_path_opt
@db_opt
@cfg_opt
def predictions_due(pred_path, db_path, config_dir):
    """Matured, unscored predictions annotated with the actual price move."""
    conn, _, settings = _common(db_path, config_dir)
    symbol = settings.get("predictions", {}).get("price_symbol", "GC")
    click.echo(predictions_mod.render_due(conn, Path(pred_path), symbol))


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
