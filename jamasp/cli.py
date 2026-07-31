"""jamasp CLI — the agent's toolbox and the operator's ops tool."""
from __future__ import annotations

import sys
from pathlib import Path

import click
import httpx

from jamasp import cluster as cluster_mod
from jamasp import db as db_mod
from jamasp import digest as digest_mod
from jamasp import extract as extract_mod
from jamasp import inbox as inbox_mod
from jamasp import notify as notify_mod
from jamasp import pricesummary as pricesummary_mod
from jamasp import wakeup as wakeup_mod
from jamasp.config import load_settings, load_sources
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
    new_items = prices_n = errors = 0
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
    click.echo(
        f"ingest: {new_items} new items ({joined} clustered), "
        f"{prices_n} price snapshots, {ledes} ledes, {errors} source errors"
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
