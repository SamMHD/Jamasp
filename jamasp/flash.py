"""Per-story gold news flashes: classify, dedupe, publish to the news channel.

Runs as the last stage of `jamasp ingest`. Never raises into the ingest run,
never marks items read, and never consumes the daily agent-run cap.
"""
from __future__ import annotations

import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone
from typing import Callable

from jamasp import config as config_mod
from jamasp import extract as extract_mod
from jamasp import flashtext
from jamasp import notify as notify_mod
from jamasp.db import utcnow

MODEL_TIMEOUT_SECONDS = 120

# Fallback ceiling for article extraction when settings omit extract_max_chars.
# Flash must always extract at the full budget — extract_cache is keyed on url
# alone with no size column, so a short extraction here would permanently cap
# what `jamasp extract` can later hand the agent for the same article.
DEFAULT_EXTRACT_MAX_CHARS = 16000

REQUIRED_CFG_KEYS = (
    "max_age_hours",
    "classify_batch_max",
    "max_posts_per_tick",
    "extract_chars",
    "decide_cmd",
    "write_cmd",
)


def _since(hours: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def log_error(conn: sqlite3.Connection, exc: object) -> None:
    conn.execute(
        "INSERT INTO source_errors (source, ts, error) VALUES ('flash', ?, ?)",
        (utcnow(), str(exc)[:500]),
    )
    conn.commit()


def record(
    conn: sqlite3.Connection, item_id: str, flash_id: str | None, state: str
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO flash_items (item_id, flash_id, state, ts)"
        " VALUES (?, ?, ?, ?)",
        (item_id, flash_id, state, utcnow()),
    )
    conn.commit()


def candidates(
    conn: sqlite3.Connection, max_age_hours: int, limit: int
) -> list[sqlite3.Row]:
    """Unprocessed items inside the age window, newest first."""
    return conn.execute(
        "SELECT i.* FROM items i"
        " LEFT JOIN flash_items f ON f.item_id = i.id"
        " WHERE f.item_id IS NULL AND i.published_at >= ?"
        " ORDER BY i.published_at DESC LIMIT ?",
        (_since(max_age_hours), limit),
    ).fetchall()


def retire_stale(conn: sqlite3.Connection, max_age_hours: int) -> int:
    """Mark unprocessed items past the window as skipped_stale. They never post."""
    cur = conn.execute(
        "INSERT INTO flash_items (item_id, flash_id, state, ts)"
        " SELECT i.id, NULL, 'skipped_stale', ? FROM items i"
        " LEFT JOIN flash_items f ON f.item_id = i.id"
        " WHERE f.item_id IS NULL AND i.published_at < ?",
        (utcnow(), _since(max_age_hours)),
    )
    conn.commit()
    return cur.rowcount


def posted_flashes(conn: sqlite3.Connection, hours: int = 24) -> list[sqlite3.Row]:
    """Delivered flashes inside the window, carrying the origin item's publish time."""
    return conn.execute(
        "SELECT f.*, i.published_at AS published_at FROM flashes f"
        " JOIN items i ON i.id = f.id"
        " WHERE f.created_at >= ? ORDER BY f.created_at",
        (_since(hours),),
    ).fetchall()


def _run_model(cmd: list[str], prompt: str) -> str:
    result = subprocess.run(
        list(cmd) + [prompt],
        capture_output=True,
        text=True,
        timeout=MODEL_TIMEOUT_SECONDS,
        check=True,
    )
    return result.stdout


def source_labels(
    conn: sqlite3.Connection, flash_id: str, display: dict[str, str]
) -> list[str]:
    """Labels for a flash's sources, in arrival order, without repeats."""
    rows = conn.execute(
        "SELECT i.source FROM flash_items f JOIN items i ON i.id = f.item_id"
        " WHERE f.flash_id = ? ORDER BY f.ts, i.published_at",
        (flash_id,),
    ).fetchall()
    labels: list[str] = []
    for r in rows:
        label = display.get(r["source"], r["source"])
        if label not in labels:
            labels.append(label)
    return labels


def _render_flash(
    conn: sqlite3.Connection, row, display: dict[str, str], extra: str | None = None
) -> str:
    labels = source_labels(conn, row["id"], display)
    if extra and extra not in labels:
        labels.append(extra)
    return flashtext.render_message(
        row["title_fa"],
        row["summary_fa"],
        row["impact_fa"],
        row["url"],
        row["published_at"],
        labels,
    )


def _publish(
    conn, item, cfg, display, chat, post, run_model, emit, dry_run, extract_max
):
    """Post one new story. Returns its flash id, or None on failure."""
    label = display.get(item["source"], item["source"])
    try:
        body = extract_mod.extract_url(conn, item["url"], extract_max)
    except Exception:
        body = ""  # not a failure: the write prompt falls back to headline + lede
    # the cache keeps the full text; only the prompt is cut down to size
    body = body[: cfg["extract_chars"]]
    prompt = flashtext.build_write_prompt(
        item["headline"], label, item["published_at"], body, item["lede"]
    )
    try:
        fields = flashtext.parse_write_response(run_model(cfg["write_cmd"], prompt))
    except Exception as exc:
        log_error(conn, exc)
        return None
    text = flashtext.render_message(
        fields["title_fa"],
        fields["summary_fa"],
        fields["impact_fa"],
        item["url"],
        item["published_at"],
        [label],
    )
    if dry_run:
        if emit:
            emit(text)
        return item["id"]
    token, chat_id = chat
    try:
        message_id = notify_mod.send_telegram(text, token, chat_id, post=post)
    except Exception as exc:
        log_error(conn, exc)
        return None
    now = utcnow()
    conn.execute(
        "INSERT INTO flashes (id, created_at, updated_at, title_en, title_fa,"
        " summary_fa, impact_fa, url, message_id, status)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')",
        (item["id"], now, now, item["headline"], fields["title_fa"],
         fields["summary_fa"], fields["impact_fa"], item["url"], message_id),
    )
    conn.commit()
    record(conn, item["id"], item["id"], "posted")
    return item["id"]


def _apply_dup(conn, item, row, display, chat, post, emit, dry_run) -> bool:
    """Fold one repeat into an existing flash. Returns False only on a retryable error."""
    label = display.get(item["source"], item["source"])
    known = source_labels(conn, row["id"], display)
    if label in known or row["status"] == "orphaned":
        # nothing to change, or nothing left to edit
        if not dry_run:
            record(conn, item["id"], row["id"], "dup")
        return True
    text = _render_flash(conn, row, display, extra=label)
    if dry_run:
        if emit:
            emit(text)
        return True
    token, chat_id = chat
    try:
        notify_mod.edit_telegram(text, token, chat_id, row["message_id"], post=post)
    except notify_mod.MessageGone:
        conn.execute(
            "UPDATE flashes SET status = 'orphaned', updated_at = ? WHERE id = ?",
            (utcnow(), row["id"]),
        )
        conn.commit()
        record(conn, item["id"], row["id"], "dup")
        return True
    except Exception as exc:
        log_error(conn, exc)
        return False
    conn.execute(
        "UPDATE flashes SET updated_at = ? WHERE id = ?", (utcnow(), row["id"])
    )
    conn.commit()
    record(conn, item["id"], row["id"], "dup")
    return True


def run_flash(
    conn: sqlite3.Connection,
    settings: dict,
    sources: list,
    post: Callable | None = None,
    run_model: Callable[[list[str], str], str] | None = None,
    emit: Callable[[str], None] | None = None,
    dry_run: bool = False,
) -> dict[str, int]:
    """One flash pass. Never raises; every failure is counted and logged."""
    stats = {"posted": 0, "dup": 0, "not_gold": 0, "stale": 0, "burst": 0, "errors": 0}
    cfg = settings.get("flash") or {}
    if not cfg.get("enabled"):
        return stats
    missing = [key for key in REQUIRED_CFG_KEYS if key not in cfg]
    if missing:
        log_error(conn, f"flash config missing keys: {', '.join(missing)}")
        stats["errors"] += 1
        return stats
    run_model = run_model or _run_model
    try:
        chat = notify_mod.resolve_chat(settings, "news")
    except RuntimeError as exc:
        log_error(conn, exc)
        stats["errors"] += 1
        return stats

    if not dry_run:
        stats["stale"] = retire_stale(conn, cfg["max_age_hours"])
    pending = candidates(conn, cfg["max_age_hours"], cfg["classify_batch_max"])
    if not pending:
        return stats

    known = {row["id"]: row for row in posted_flashes(conn)}
    try:
        verdicts = flashtext.parse_decide_response(
            run_model(cfg["decide_cmd"], flashtext.build_decide_prompt(
                list(known.values()), pending
            ))
        )
    except Exception as exc:
        log_error(conn, exc)
        stats["errors"] += 1
        return stats

    display = config_mod.display_names(sources)
    extract_max = settings.get("extract_max_chars", DEFAULT_EXTRACT_MAX_CHARS)
    budget = cfg["max_posts_per_tick"]
    for item in pending:
        verdict = verdicts.get(item["id"])
        if verdict is None:
            continue  # unclassified: left unprocessed, retried next tick
        if not verdict["gold"]:
            if not dry_run:
                record(conn, item["id"], None, "not_gold")
            stats["not_gold"] += 1
            continue
        target_id = verdict["dup_of"]
        row = known.get(target_id) if target_id else None
        if row is not None:
            if _apply_dup(conn, item, row, display, chat, post, emit, dry_run):
                stats["dup"] += 1
            else:
                stats["errors"] += 1
            continue
        if budget <= 0:
            if not dry_run:
                record(conn, item["id"], None, "skipped_burst")
            stats["burst"] += 1
            continue
        flash_id = _publish(
            conn, item, cfg, display, chat, post, run_model, emit, dry_run,
            extract_max,
        )
        if flash_id is None:
            stats["errors"] += 1
            continue
        budget -= 1
        stats["posted"] += 1
        if not dry_run:
            # Re-read known flashes so a later candidate naming this item's id
            # as dup_of resolves against the flash it just produced. A
            # candidate that names an id that was never published — not_gold,
            # failed to write, or lost to the burst cap — simply misses this
            # lookup and is treated as a new story, which is the safe
            # direction.
            known = {row["id"]: row for row in posted_flashes(conn)}
    return stats
