"""Per-story gold news flashes: classify, dedupe, publish to the news channel.

Runs as the last stage of `jamasp ingest`. Never raises into the ingest run,
never marks items read, and never consumes the daily agent-run cap.
"""
from __future__ import annotations

import contextlib
import fcntl
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


def lock_path(conn: sqlite3.Connection) -> str:
    """Lock file guarding the passes that publish from this database.

    Derived from the database file rather than fixed, so each database — the
    live one, a tmp_path one in a test — has its own lock.
    """
    row = conn.execute("PRAGMA database_list").fetchone()
    dbfile = (row["file"] if row else "") or ""
    return f"{dbfile}.passlock" if dbfile else ""


@contextlib.contextmanager
def pass_lock(conn: sqlite3.Connection):
    """Yield True if this process may publish, False if another pass holds it.

    Two schedulers reach the flash pass: the 15-minute ingest timer and the
    agent runs, which CLAUDE.md tells to call `jamasp ingest` when the inbox
    looks stale. `candidates()` excludes items that already have a flash_items
    row, but `_publish` writes that row only after the Telegram send — so two
    concurrent passes both saw the same item unclaimed, both posted it, and the
    loser died on the flashes primary key. That put a duplicate flash in the
    channel and left the story unrecorded, daily, at 03:32.

    Skipping rather than waiting is deliberate: the loser's work is redundant by
    definition, and the next tick is at most 15 minutes away. An in-memory
    database has no path to lock and never has a second writer, so it proceeds.
    """
    path = lock_path(conn)
    if not path:
        yield True
        return
    handle = open(path, "a")
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
    finally:
        handle.close()


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
    conn: sqlite3.Connection,
    item_id: str,
    flash_id: str | None,
    state: str,
    commit: bool = True,
    tier: int | None = None,
    rollup_id: int | None = None,
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO flash_items"
        " (item_id, flash_id, state, ts, tier, rollup_id)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (item_id, flash_id, state, utcnow(), tier, rollup_id),
    )
    if commit:
        conn.commit()


def held_item_ids(conn: sqlite3.Connection) -> set[str]:
    """Items classified for a rollup and not yet sent in one."""
    return {
        r["item_id"]
        for r in conn.execute("SELECT item_id FROM flash_items WHERE state = 'held'")
    }


# Tier boundaries, overridable in config: at or above post_tier_min goes to
# the channel now, at or above rollup_tier_min waits for a rollup, below that
# never reaches the channel. Config rather than constants because the tier
# definitions are a judgement that needs tuning once a week of data exists.
DEFAULT_POST_TIER_MIN = 4
DEFAULT_ROLLUP_TIER_MIN = 3

# Share of each batch held for the items closest to the age cliff. Ordering
# purely by published_at DESC lets every tick's fresh arrivals outrank items
# already near expiry, which then retire unclassified — a burst of TA columns
# can bury a material headline it happens to outrank.
_OLDEST_RESERVE = 1 / 3

_CANDIDATE_SQL = (
    "SELECT i.* FROM items i"
    " LEFT JOIN flash_items f ON f.item_id = i.id"
    " WHERE f.item_id IS NULL AND i.published_at >= ?"
    " ORDER BY i.published_at {} LIMIT ?"
)


def candidates(
    conn: sqlite3.Connection, max_age_hours: int, limit: int
) -> list[sqlite3.Row]:
    """Unprocessed items inside the age window, newest first.

    Most of the batch goes to the newest items — a news channel's value is
    freshness — but `_OLDEST_RESERVE` of it is kept for those closest to
    ageing out, so a sustained burst can't starve them.
    """
    since = _since(max_age_hours)
    reserve = int(limit * _OLDEST_RESERVE)
    oldest = (
        conn.execute(_CANDIDATE_SQL.format("ASC"), (since, reserve)).fetchall()
        if reserve
        else []
    )
    picked = {r["id"]: r for r in oldest}
    for row in conn.execute(_CANDIDATE_SQL.format("DESC"), (since, limit)):
        if len(picked) >= limit:
            break
        picked.setdefault(row["id"], row)
    # newest first, as before: the reserve changes which items are in the
    # batch, not the order they're handed downstream
    return sorted(picked.values(), key=lambda r: r["published_at"], reverse=True)


def retire_stale(conn: sqlite3.Connection, max_age_hours: int) -> dict[str, int]:
    """Mark unprocessed items past the window as skipped. They never post.

    Returns `{"stale": n, "born_old": m}` — two states, because the causes are
    unrelated and one is not a defect: `skipped_born_old` was already outside
    the window when first fetched (feed archive entries, a first-ingest
    backfill) and was never postable; `skipped_stale` was fresh when we saw it
    and aged out before being classified, which is the only one of the two
    worth alarming on. Reporting one conflated total made a 70-item
    starvation read as 4143.
    """
    now, since = utcnow(), _since(max_age_hours)
    # Two statements rather than one CASE, so each rowcount is exactly the
    # number of rows that pass inserted — no counting back by timestamp.
    counts = {}
    for state, age_test in (("skipped_born_old", ">="), ("skipped_stale", "<")):
        counts[state] = conn.execute(
            "INSERT INTO flash_items (item_id, flash_id, state, ts)"
            f" SELECT i.id, NULL, '{state}', ? FROM items i"
            " LEFT JOIN flash_items f ON f.item_id = i.id"
            " WHERE f.item_id IS NULL AND i.published_at < ?"
            "   AND (julianday(i.fetched_at) - julianday(i.published_at)) * 24"
            f"       {age_test} ?",
            (now, since, max_age_hours),
        ).rowcount
    conn.commit()
    return {"stale": counts["skipped_stale"], "born_old": counts["skipped_born_old"]}


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


UNREADABLE = object()  # the write model refused: source text was not an article


def _publish(
    conn, item, cfg, display, chat, post, run_model, emit, dry_run, extract_max,
    tier=None,
):
    """Post one new story.

    Returns its flash id, None on a retryable failure, or UNREADABLE when the
    write model declined the source text.
    """
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
        text = flashtext.render_message(
            fields["title_fa"],
            fields["summary_fa"],
            fields["impact_fa"],
            item["url"],
            item["published_at"],
            [label],
        )
    except flashtext.SourceUnusable:
        # Not a failure and not worth retrying: the link will still be a consent
        # wall next tick. Record it so it stops being a candidate.
        if not dry_run:
            record(conn, item["id"], None, "unreadable")
        return UNREADABLE
    except Exception as exc:
        log_error(conn, exc)
        return None
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
    try:
        # One transaction. A flashes row without its flash_items row would make
        # the item a candidate again next tick: a second Telegram message, then
        # a PRIMARY KEY collision on flashes.id — every tick until it ages out.
        with conn:
            conn.execute(
                "INSERT INTO flashes (id, created_at, updated_at, title_en,"
                " title_fa, summary_fa, impact_fa, url, message_id, status)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')",
                (item["id"], now, now, item["headline"], fields["title_fa"],
                 fields["summary_fa"], fields["impact_fa"], item["url"],
                 message_id),
            )
            record(conn, item["id"], item["id"], "posted", commit=False, tier=tier)
    except Exception as exc:
        log_error(conn, exc)
        return None
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
    try:
        text = _render_flash(conn, row, display, extra=label)
    except Exception as exc:
        log_error(conn, exc)
        return False
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


def record_scores(conn: sqlite3.Connection, verdicts: dict[str, dict]) -> int:
    """Persist the triage verdict for every fully-scored gold item.

    Deliberately independent of delivery. An item held for a rollup, folded
    as a duplicate, or dropped as low tier is still news the market map has
    to show, so this runs over the whole verdict batch before the delivery
    loop makes any of those decisions.

    Non-gold items are skipped: a gold desk's map has no box for them.
    Partly-scored items are skipped too — writing a missing direction as 0
    would render a fabricated confident-neutral tile.
    """
    rows = [
        (item_id, v["tier"], v["direction"], v["conviction"], v["theme"],
         utcnow())
        for item_id, v in verdicts.items()
        if v["gold"]
        and v["tier"] is not None
        and v["direction"] is not None
        and v["conviction"] is not None
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO item_scores"
        " (item_id, tier, direction, conviction, theme, scored_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    return len(rows)


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
    stats = {"posted": 0, "dup": 0, "not_gold": 0, "unreadable": 0, "stale": 0,
             "born_old": 0, "held": 0, "low_tier": 0, "no_tier": 0,
             "burst": 0, "skipped_locked": 0, "errors": 0, "scored": 0}
    try:
        # A dry run sends nothing and writes nothing, so a live pass must not
        # block the operator from rendering one.
        if dry_run:
            return _run_pass(conn, settings, sources, post, run_model, emit,
                             dry_run, stats)
        with pass_lock(conn) as acquired:
            if not acquired:
                stats["skipped_locked"] = 1
                return stats
            return _run_pass(conn, settings, sources, post, run_model, emit,
                             dry_run, stats)
    except Exception as exc:
        # Last line of defence: ingest finishes whatever happens in here. The
        # per-step handlers below cover the expected failures; this covers a
        # locked database, a malformed row, anything unforeseen.
        stats["errors"] += 1
        try:
            log_error(conn, exc)
        except Exception:
            pass
        return stats


def _run_pass(conn, settings, sources, post, run_model, emit, dry_run, stats):
    """The pass itself. Mutates and returns stats; run_flash owns the guard."""
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
        stats.update(retire_stale(conn, cfg["max_age_hours"]))
    pending = candidates(conn, cfg["max_age_hours"], cfg["classify_batch_max"])
    if not pending:
        return stats

    known = {row["id"]: row for row in posted_flashes(conn)}
    themes = config_mod.themes(config_mod.load_weights())
    try:
        verdicts = flashtext.parse_decide_response(
            run_model(cfg["decide_cmd"], flashtext.build_decide_prompt(
                list(known.values()), pending, themes
            )),
            themes,
        )
    except Exception as exc:
        log_error(conn, exc)
        stats["errors"] += 1
        return stats

    if not dry_run:
        stats["scored"] = record_scores(conn, verdicts)

    display = config_mod.display_names(sources)
    extract_max = settings.get("extract_max_chars", DEFAULT_EXTRACT_MAX_CHARS)
    budget = cfg["max_posts_per_tick"]
    post_tier_min = cfg.get("post_tier_min", DEFAULT_POST_TIER_MIN)
    rollup_tier_min = cfg.get("rollup_tier_min", DEFAULT_ROLLUP_TIER_MIN)
    held = held_item_ids(conn)
    for item in pending:
        verdict = verdicts.get(item["id"])
        if verdict is None:
            continue  # unclassified: left unprocessed, retried next tick
        if not verdict["gold"]:
            if not dry_run:
                record(conn, item["id"], None, "not_gold")
            stats["not_gold"] += 1
            continue
        tier = verdict["tier"]
        if tier is None:
            # The model dropped the field. Fall through to today's behaviour —
            # post it — because a visible over-post is self-correcting and a
            # silently suppressed material story is not. Counted so the rate
            # is observable rather than assumed.
            stats["no_tier"] += 1
        target_id = verdict["dup_of"]
        row = known.get(target_id) if target_id else None
        if row is not None:
            if _apply_dup(conn, item, row, display, chat, post, emit, dry_run):
                stats["dup"] += 1
            else:
                stats["errors"] += 1
            continue
        if target_id and target_id in held:
            # The story it repeats is queued for a rollup, so there is no
            # message to edit. Publishing this copy as a new story would put
            # the same narrative in the channel twice — once now, once as a
            # rollup line.
            if not dry_run:
                record(conn, item["id"], None, "dup", tier=tier)
            stats["dup"] += 1
            continue
        if tier is not None and tier < rollup_tier_min:
            if not dry_run:
                record(conn, item["id"], None, "skipped_low_tier", tier=tier)
            stats["low_tier"] += 1
            continue
        if tier is not None and tier < post_tier_min:
            if not dry_run:
                record(conn, item["id"], None, "held", tier=tier)
            held.add(item["id"])
            stats["held"] += 1
            continue
        if budget <= 0:
            if not dry_run:
                record(conn, item["id"], None, "skipped_burst")
            stats["burst"] += 1
            continue
        flash_id = _publish(
            conn, item, cfg, display, chat, post, run_model, emit, dry_run,
            extract_max, tier=tier,
        )
        if flash_id is UNREADABLE:
            # no message, so it never cost a slot in the per-tick budget
            stats["unreadable"] += 1
            continue
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


DEFAULT_ROLLUP_MIN_ITEMS = 3
# Ceiling per rollup. Telegram hard-rejects past 4096 chars, and a rejected send
# leaves every item held — so the next window is larger and the rollup wedges
# permanently. 20 one-line items sit well inside the limit; the remainder is
# carried, named in the message, and drains at the head of the next window.
DEFAULT_ROLLUP_MAX_ITEMS = 20


def held_items(
    conn: sqlite3.Connection, limit: int | None = None
) -> list[sqlite3.Row]:
    """Held items with the fields the rollup prompt needs, oldest first.

    Oldest-first with a limit means a carried-over item drains at the head of
    the queue rather than being starved by a steady arrival of newer ones.
    """
    sql = (
        "SELECT i.id, i.source, i.headline, i.lede, i.published_at, f.tier"
        " FROM flash_items f JOIN items i ON i.id = f.item_id"
        " WHERE f.state = 'held' ORDER BY i.published_at"
    )
    if limit is None:
        return conn.execute(sql).fetchall()
    return conn.execute(f"{sql} LIMIT ?", (limit,)).fetchall()


def held_count(conn: sqlite3.Connection) -> int:
    return conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE state = 'held'"
    ).fetchone()["c"]


def run_rollup(
    conn: sqlite3.Connection,
    settings: dict,
    post: Callable | None = None,
    run_model: Callable[[list[str], str], str] | None = None,
    emit: Callable[[str], None] | None = None,
    dry_run: bool = False,
) -> dict[str, int]:
    """Send one periodic roundup of held (middle-tier) stories.

    Nothing is marked `rolled_up` unless Telegram accepted the message: on any
    failure the items stay held and the next window retries them. Never raises
    — the timer that drives this must not fail on a model hiccup.
    """
    stats = {"items": 0, "sent": 0, "below_floor": 0, "carried": 0,
             "skipped_locked": 0, "errors": 0}
    try:
        # Same lock as the flash pass: both publish to the channel, and a rollup
        # racing a flash could send lines for a story the flash is posting.
        if dry_run:
            return _rollup_pass(conn, settings, post, run_model, emit, dry_run,
                                stats)
        with pass_lock(conn) as acquired:
            if not acquired:
                stats["skipped_locked"] = 1
                return stats
            return _rollup_pass(conn, settings, post, run_model, emit, dry_run,
                                stats)
    except Exception as exc:
        stats["errors"] += 1
        try:
            log_error(conn, exc)
        except Exception:
            pass
        return stats


def _rollup_pass(conn, settings, post, run_model, emit, dry_run, stats):
    cfg = settings.get("flash") or {}
    if not cfg.get("enabled"):
        return stats
    run_model = run_model or _run_model
    total_held = held_count(conn)
    cap = cfg.get("rollup_max_items", DEFAULT_ROLLUP_MAX_ITEMS)
    rows = held_items(conn, limit=cap)
    stats["items"] = len(rows)
    stats["carried"] = max(0, total_held - len(rows))
    if not rows:
        return stats
    floor = cfg.get("rollup_min_items", DEFAULT_ROLLUP_MIN_ITEMS)
    if len(rows) < floor:
        # Left held on purpose: they roll into the next window.
        stats["below_floor"] = len(rows)
        return stats
    try:
        chat = notify_mod.resolve_chat(settings, "news")
    except RuntimeError as exc:
        log_error(conn, exc)
        stats["errors"] += 1
        return stats
    items = [
        {"id": r["id"], "source": r["source"], "headline": r["headline"],
         "lede": r["lede"]}
        for r in rows
    ]
    try:
        groups = flashtext.parse_rollup_response(
            run_model(
                cfg.get("rollup_cmd") or cfg["write_cmd"],
                flashtext.build_rollup_prompt(items),
            )
        )
        text = flashtext.render_rollup(groups, carried=stats["carried"])
    except Exception as exc:
        log_error(conn, exc)
        stats["errors"] += 1
        return stats
    if dry_run:
        if emit:
            emit(text)
        return stats
    token, chat_id = chat
    try:
        message_id = notify_mod.send_telegram(text, token, chat_id, post=post)
    except Exception as exc:
        log_error(conn, exc)
        stats["errors"] += 1
        return stats
    try:
        # One transaction: a rollups row whose items stayed held would send the
        # same lines again next window.
        with conn:
            cur = conn.execute(
                "INSERT INTO rollups (created_at, text_fa, message_id, status)"
                " VALUES (?, ?, ?, 'sent')",
                (utcnow(), text, message_id),
            )
            rollup_id = cur.lastrowid
            for r in rows:
                # carry the tier forward: it is the data that makes the
                # thresholds reviewable after a week of live scoring
                record(
                    conn, r["id"], None, "rolled_up", commit=False,
                    tier=r["tier"], rollup_id=rollup_id,
                )
    except Exception as exc:
        log_error(conn, exc)
        stats["errors"] += 1
        return stats
    stats["sent"] = 1
    return stats
