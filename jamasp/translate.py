"""Fill Persian renderings of everything the panel renders.

Four passes: a free SQL copy of Persian the flash pipeline already wrote, two
batched model passes over `items` and `events`, and a sidecar pass over the
documents agent runs write. Presentation only — no analysis run ever reads
Persian, and nothing here touches Telegram.

Runs on its own timer, never wrapped by `jamasp run`, so it consumes none of
the daily agent-run cap.
"""
from __future__ import annotations

import contextlib
import json
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Sequence

import yaml

from jamasp import config as config_mod
from jamasp import modelrun, translatetext
from jamasp.db import set_meta, utcnow


def reuse_flash_persian(conn: sqlite3.Connection, now: str | None = None) -> int:
    """Copy Persian from delivered flashes into `items`. No model calls.

    Runs before the model pass, and the order is load-bearing: a rows pass
    that ran first would pay to translate what the channel already wrote — and
    produce a second, different Persian headline for the same story.

    The join is `flashes.id = items.id`, so what this covers is items POSTED
    to the channel in their own right. A middle-tier story held for a rollup
    has no `flashes` row (`_rollup_pass` records it with `flash_id = None`),
    and a duplicate's `flash_items` row points at another story's flash id —
    both pay the model like anything else. The design spec's reuse section
    carries the same correction and the option that would widen it.

    `'sent'` only. A flash marked `'orphaned'` lost its channel message, which
    means something went wrong with that story's publication; it earns its
    translation through the normal path instead.
    """
    stamp = now or utcnow()
    cur = conn.execute(
        "UPDATE items SET"
        "   headline_fa = (SELECT title_fa FROM flashes f WHERE f.id = items.id),"
        "   lede_fa     = (SELECT summary_fa FROM flashes f WHERE f.id = items.id),"
        "   fa_source   = 'flash',"
        "   fa_at       = ?"
        " WHERE headline_fa IS NULL"
        "   AND EXISTS (SELECT 1 FROM flashes f"
        "               WHERE f.id = items.id AND f.status = 'sent')",
        (stamp,),
    )
    conn.commit()
    return cur.rowcount


MAX_ATTEMPTS = 3
ROW_FIELDS = ("headline", "lede")


def _since(window_days: int, now: str | None = None) -> str:
    base = datetime.strptime(now or utcnow(), "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc
    )
    return (base - timedelta(days=window_days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def floor_for(cfg: dict, window_days: int, now: str | None = None) -> str:
    """The oldest `published_at` this pass will translate.

    Normally the rolling window: everything published in the last
    `window_days`. But `translate.translate_from` pins a hard floor under it,
    and the later of the two wins.

    That floor exists because the rolling window is also a BACKFILL
    instruction. Pointed at a database with months of history, the first tick
    does not see "today's news" — it sees every item published in the last
    seven days, all untranslated, and works through the lot. On this host that
    was ~2,800 items on the first run, and the run cost far more than the
    arithmetic suggests: once the translator starts refusing, every batch of
    20 falls back to 20 single calls, so a failing tick costs 22x a healthy
    one (see `_batch_with_fallback`). The backfill exhausted the codex quota,
    the quota errors then triggered the fallback on every batch, and 1,861
    rows were driven to the attempt cap and abandoned.

    Setting `translate_from` to the day the desk turned this on makes the job
    forward-only: it translates what arrives from here, and never reaches back
    for history. History stays English, which is what the panel's EN marker is
    for.

    Omit the key and the behaviour is the old rolling window, so an operator
    who wants a deliberate, supervised backfill can still have one by clearing
    it.
    """
    window = _since(window_days, now)
    # str() before strip(): an operator who writes `translate_from: 2026-09-21`
    # without quotes gets a datetime.date from the YAML loader, not a string,
    # and .strip() on that would crash the pass at the first tick — a config
    # typo taking the job down rather than being read as the date it obviously
    # is.
    raw = cfg.get("translate_from")
    pinned = "" if raw is None else str(raw).strip()
    if not pinned:
        return window
    # A bare date means midnight UTC that day; anything longer is used as-is,
    # so an operator can pin an exact moment rather than a whole day.
    floor = f"{pinned}T00:00:00Z" if len(pinned) == 10 else pinned
    return max(window, floor)


# How long a row waits after its Nth failure before it is offered again — one
# delay per failure that can still be retried, so the tuple is MAX_ATTEMPTS - 1
# long. A third delay would be dead code: `pending_rows` filters
# `fa_attempts < MAX_ATTEMPTS`, so a row that has failed three times is already
# abandoned and no delay of its own is ever read.
#
# Spec decision 12 is "attempt counter + status, backoff" and the cap alone is
# not backoff: the timer fires every 10 minutes, so three ticks inside half an
# hour used to walk the same rows straight to MAX_ATTEMPTS — a row was given up
# 20 minutes into an outage. With these delays the attempts land at t+0, t+20
# and t+80, so it now survives 80 minutes: long enough to ride out a restart,
# an ingest storm or a short auth wobble, and NOT long enough to ride out a
# Friday-evening outage. Anything longer than 80 minutes still abandons the
# window, and `--force` is what brings it back.
BACKOFF_MINUTES = (15, 60)


def _backoff(now: str) -> tuple[str, list[str]]:
    """SQL fragment + params that skip a row still inside its backoff.

    `fa_attempts = 0` is exempt: --force resets the counter without clearing
    `fa_failed_at`, and a re-armed row must be eligible immediately.

    The CASE arms are generated from BACKOFF_MINUTES so the two cannot drift.
    ELSE repeats the longest delay; it is unreachable today, and it is there
    for the one change that would reach it — raising MAX_ATTEMPTS without
    extending the tuple, which should back a row off further rather than let it
    retry on every tick.
    """
    base = datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc)
    thresholds = [
        (base - timedelta(minutes=m)).strftime("%Y-%m-%dT%H:%M:%SZ")
        for m in BACKOFF_MINUTES
    ]
    arms = " ".join(f"WHEN {n} THEN ?"
                    for n in range(1, len(BACKOFF_MINUTES) + 1))
    return (
        " AND (fa_failed_at IS NULL OR fa_attempts = 0"
        f"      OR fa_failed_at <= CASE fa_attempts {arms} ELSE ? END)",
        thresholds + thresholds[-1:],
    )


def pending_rows(
    conn: sqlite3.Connection, window_days: int, limit: int,
    now: str | None = None, force: bool = False, since: str | None = None,
    scored_only: bool = False,
) -> list[sqlite3.Row]:
    """Untranslated items inside the window, newest first.

    Newest first is the priority order that matters: the freshest headline is
    the one somebody is looking at, and a backlog larger than a tick's ceiling
    drains from the top over subsequent ticks.

    The attempt cap is applied here rather than at write time so an abandoned
    row costs nothing to skip — it never enters a batch again.

    Under `force` the filter widens to rows that already have Persian, but only
    where that Persian came from a model (`fa_source` 'model', or NULL for a
    row that has none yet). Rows whose `fa_source` is 'flash' are left alone:
    that Persian is the news channel's own editorial wording, it arrived free
    from the reuse pass, and re-translating it would both spend a call and give
    the same story two different Persian headlines. The reuse pass owns those
    rows.

    `scored_only` (config key `translate.scored_only`) narrows the candidate
    set to items carrying an `item_scores` row — the same join
    `getScoredItems` (panel/lib/db.ts) makes onto the technical map. This is
    NOT the only panel surface that reads `headline_fa`/`lede_fa`: the inbox
    (`getItems`, `panel/components/inbox-table.tsx`) and the dashboard's
    cluster/top-story views (`getClusterHeads`/`topStory`,
    `panel/components/news-flow.tsx`) read them too, over plain `SELECT *
    FROM items` with no `item_scores` join. The map is only the surface we
    are PAYING to translate for — a deliberate desk choice, not a technical
    limit — so a Persian viewer will keep seeing the English-with-EN-marker
    fallback on the inbox and dashboard for any item this filter excludes.
    Ties translation spend to what the map actually renders rather than to
    mere recency: measured on the live host, the 7-day window's pending
    backlog was 1,971 items under the plain rolling window; of the 1,332
    items in that window that are actually scored, only 814 were
    untranslated — a 59% cut to the backlog, to roughly 41 batches for the
    whole thing. `item_scores.item_id` is that table's primary key, so the
    EXISTS check costs an index lookup, not a scan. Defaults to off so an
    unconfigured deployment keeps the old "everything in the window"
    behaviour.
    """
    stamp = now or utcnow()
    clause, thresholds = _backoff(stamp)
    selector = ("(fa_source IS NULL OR fa_source = 'model')" if force
                else "headline_fa IS NULL")
    scored_clause = (
        " AND EXISTS (SELECT 1 FROM item_scores s WHERE s.item_id = items.id)"
        if scored_only else ""
    )
    return conn.execute(
        f"SELECT id, headline, lede FROM items"
        f" WHERE {selector} AND published_at >= ? AND fa_attempts < ?"
        f"{clause}{scored_clause}"
        " ORDER BY published_at DESC LIMIT ?",
        (since or _since(window_days, stamp), MAX_ATTEMPTS, *thresholds, limit),
    ).fetchall()


def rearm(conn: sqlite3.Connection, table: str, column: str,
          window_days: int, now: str | None = None,
          scored_only: bool = False) -> int:
    """`--force`'s first half: clear the abandonment state inside the window.

    The spec is explicit that --force does not merely ignore the cap, it
    resets it — "an operator clearing a known-bad state does not have to edit
    the database". Scoped to the window because rows outside it are never
    translated anyway.

    `scored_only` mirrors `pending_rows`'s own filter of the same name, and
    for the same reason: without it, `--force` run against a `scored_only`
    config would re-arm every abandoned row in the window but then actually
    retranslate only the scored ones, leaving the rest sitting at
    `fa_attempts = 0` with nothing to pick them up until `scored_only` is
    turned off — a state that quietly outlives the run that created it and
    contradicts "re-arms exactly the map set and nothing wider". Meaningful
    only for `table == "items"`, since `item_scores` keys off `items.id`; the
    events pass never sets it.
    """
    scored_clause = (
        f" AND EXISTS (SELECT 1 FROM item_scores s WHERE s.item_id = {table}.id)"
        if scored_only else ""
    )
    cur = conn.execute(
        f"UPDATE {table} SET fa_attempts = 0, fa_error = NULL"
        f" WHERE {column} >= ? AND (fa_attempts > 0 OR fa_error IS NOT NULL)"
        f"{scored_clause}",
        (_since(window_days, now),),
    )
    conn.commit()
    return cur.rowcount


def _write_row(conn, item_id: str, entry: dict, now: str) -> None:
    conn.execute(
        "UPDATE items SET headline_fa = ?, lede_fa = ?, fa_source = 'model',"
        " fa_at = ?, fa_error = NULL WHERE id = ?",
        (entry["headline"], entry.get("lede"), now, item_id),
    )


def _record_failure(conn, item_id: str, error: str, now: str) -> None:
    conn.execute(
        "UPDATE items SET fa_attempts = fa_attempts + 1, fa_error = ?,"
        " fa_failed_at = ? WHERE id = ?",
        (error[:500], now, item_id),
    )


def _translate_batch(
    rows: Sequence[sqlite3.Row], fields: Sequence[str], glossary: dict, run
) -> dict[int, dict[str, str]]:
    """One model call for `rows`, returning {position: {field: text}}.

    Raises ModelError or ParseError; the caller decides whether to retry the
    batch or fall back to singles.

    `rows` are converted to plain dicts here because sqlite3.Row supports
    `row[key]` but not `row.get(key)`, which build_rows_prompt relies on to
    skip fields a row doesn't have.
    """
    prompt = translatetext.build_rows_prompt(
        [dict(row) for row in rows], fields, glossary
    )
    payload = run(prompt, translatetext.rows_schema(fields))
    return translatetext.parse_rows_response(payload, len(rows), fields)


# What a row-level failure is allowed to be. sqlite3.OperationalError is in
# here because contention runs both ways: this job is not the only writer, and
# a `database is locked` raised by one row's UPDATE must degrade into a
# recorded failure — the next tick retries the row — rather than ending the run
# with a traceback and half the backlog untried.
ROW_FAILURES = (modelrun.ModelError, translatetext.ParseError,
                sqlite3.OperationalError)


def _commit(conn, action) -> bool:
    """Run one write and commit it. False when the database was locked.

    The commit is the point. SQLite has a single write lock, `jamasp.db` sets
    busy_timeout to 5s and runs without WAL, so a transaction left open across
    a model call (`timeout_seconds: 180`) locks out ingest, flash, the brief
    and `predictions add` for as long as the call takes.
    """
    try:
        action()
        conn.commit()
        return True
    except sqlite3.OperationalError:
        with contextlib.suppress(sqlite3.Error):
            conn.rollback()
        return False


def _batch_with_fallback(
    conn, rows, fields, glossary, run, now, write, fail
) -> tuple[int, int]:
    """Translate one batch: try it, retry once, then one call per row.

    A malformed or refused response costs the whole batch, so one bad headline
    must not be allowed to poison nineteen good ones.

    modelrun.QuotaExhausted is deliberately NOT caught here — it propagates
    straight out to the caller. Retrying it, let alone falling back to one
    call per row, spends calls that are guaranteed to fail identically: every
    other call in the run is subject to the same exhausted allowance. That
    fan-out (1 call becomes 22) is what drove 1,861 rows to the attempt cap
    across three outages on the live host (docs/todo/025); the fix is to cost
    exactly the one call that discovered the outage and stop.
    """
    for attempt in (1, 2):
        try:
            answers = _translate_batch(rows, fields, glossary, run)
        except modelrun.QuotaExhausted:
            raise   # see the docstring above — no retry, no singles fallback
        except ROW_FAILURES:
            if attempt == 2:
                break
            continue
        # One transaction for the batch, and no model call inside it: the
        # answers are already in hand, so the write lock is held for the
        # length of the writes and nothing else.
        translated = 0
        try:
            for position, row in enumerate(rows):
                entry = answers.get(position)
                if entry:
                    write(conn, row["id"], entry, now)
                    translated += 1
                else:
                    fail(conn, row["id"], "model omitted this entry", now)
            conn.commit()
        except sqlite3.OperationalError:
            with contextlib.suppress(sqlite3.Error):
                conn.rollback()
            return 0, len(rows)   # nothing written; the next tick retries
        return translated, len(rows) - translated

    translated = failed = 0
    for row in rows:
        try:
            answers = _translate_batch([row], fields, glossary, run)
        except modelrun.QuotaExhausted:
            # Quota can also run out mid-fallback (the batch failed for an
            # ordinary reason, singles started, and THEN the allowance hit
            # zero). Same rule applies: stop paying for calls guaranteed to
            # fail, rather than working through the rest of the batch.
            raise
        except ROW_FAILURES as exc:
            _record(conn, fail, row["id"], str(exc), now)
            failed += 1
            continue
        entry = answers.get(0)
        if not entry:
            _record(conn, fail, row["id"], "model omitted this entry", now)
            failed += 1
            continue
        # Committed here, before the next iteration's model call — see _commit.
        if _commit(conn, lambda: write(conn, row["id"], entry, now)):
            translated += 1
        else:
            failed += 1
    return translated, failed


def _record(conn, fail, row_id: str, error: str, now: str) -> None:
    """Record a row failure, best effort. Swallows a locked database.

    The failure record is itself a write, so the one thing it cannot do is
    raise the same error it exists to absorb. A row whose attempt could not be
    counted simply keeps its old count and is retried next tick.
    """
    _commit(conn, lambda: fail(conn, row_id, error, now))


def _run_batches(
    conn, rows, batch_size: int, fields, glossary, run, now, write, fail
) -> dict:
    """Split `rows` into batches and translate each in turn. Returns counts.

    Stops the moment a batch raises modelrun.QuotaExhausted, instead of
    moving on to the next one: every remaining batch in this pass is subject
    to the same exhausted allowance and would fail identically, so continuing
    would only spend calls to confirm what the first failure already proved.
    The rows in the batch that triggered it are left exactly as they were —
    `_batch_with_fallback` raises before writing anything for them — so
    nothing is recorded as failed and no attempt is spent (see
    modelrun.QuotaExhausted's docstring).

    The caller (translate_rows / translate_events) learns about the stop
    through `quota_exhausted` in the returned dict, which is how
    `run_translate` knows to skip the passes after this one too.
    """
    translated = failed = batches = 0
    for start in range(0, len(rows), batch_size):
        chunk = rows[start:start + batch_size]
        try:
            ok, bad = _batch_with_fallback(
                conn, chunk, fields, glossary, run, now, write, fail,
            )
        except modelrun.QuotaExhausted as exc:
            batches += 1   # one call WAS made — the one that found this out
            return {
                "translated": translated, "failed": failed,
                "batches": batches, "quota_exhausted": True,
                "quota_message": str(exc),
            }
        translated += ok
        failed += bad
        batches += 1
    return {"translated": translated, "failed": failed, "batches": batches}


def translate_rows(
    conn: sqlite3.Connection, cfg: dict, glossary: dict,
    run: Callable[[str, dict], object], now: str | None = None,
    force: bool = False,
) -> dict:
    """Translate pending items in batches. Returns counts."""
    stamp = now or utcnow()
    batch_size = cfg["batch_size"]
    ceiling = cfg["max_batches_per_run"]
    # Absent means the old "everything in the window" behaviour — opt-in at
    # the config layer, see pending_rows's docstring.
    scored_only = cfg.get("scored_only", False)
    if force:
        rearm(conn, "items", "published_at", cfg["window_days"], stamp,
              scored_only=scored_only)
    rows = pending_rows(
        conn, cfg["window_days"], batch_size * ceiling, stamp, force,
        since=floor_for(cfg, cfg["window_days"], stamp),
        scored_only=scored_only)

    return _run_batches(conn, rows, batch_size, ROW_FIELDS, glossary, run,
                        stamp, _write_row, _record_failure)


EVENT_FIELDS = ("title",)


def pending_events(
    conn: sqlite3.Connection, window_days: int, limit: int,
    now: str | None = None, force: bool = False, since: str | None = None,
) -> list[sqlite3.Row]:
    """Untranslated events from the recent past forward, soonest first.

    No upper bound: the calendar is a forward-looking view, so every future
    event qualifies. The window only bounds how far back a just-passed event
    stays worth translating.

    `force` widens this to every in-window event. Unlike items there is no
    `fa_source` to protect: nothing but this job ever writes `title_fa`.
    """
    stamp = now or utcnow()
    clause, thresholds = _backoff(stamp)
    selector = "1 = 1" if force else "title_fa IS NULL"
    return conn.execute(
        f"SELECT id, title FROM events"
        f" WHERE {selector} AND starts_at >= ? AND fa_attempts < ?{clause}"
        " ORDER BY starts_at LIMIT ?",
        (since or _since(window_days, stamp), MAX_ATTEMPTS, *thresholds, limit),
    ).fetchall()


def _write_event(conn, event_id: str, entry: dict, now: str) -> None:
    conn.execute(
        "UPDATE events SET title_fa = ?, fa_at = ?, fa_error = NULL WHERE id = ?",
        (entry["title"], now, event_id),
    )


def _record_event_failure(conn, event_id: str, error: str, now: str) -> None:
    conn.execute(
        "UPDATE events SET fa_attempts = fa_attempts + 1, fa_error = ?,"
        " fa_failed_at = ? WHERE id = ?",
        (error[:500], now, event_id),
    )


def translate_events(
    conn: sqlite3.Connection, cfg: dict, glossary: dict,
    run: Callable[[str, dict], object], now: str | None = None,
    force: bool = False,
) -> dict:
    """Translate pending calendar events in batches. Returns counts."""
    stamp = now or utcnow()
    batch_size = cfg["batch_size"]
    ceiling = cfg["max_batches_per_run"]
    if force:
        rearm(conn, "events", "starts_at", cfg["window_days"], stamp)
    rows = pending_events(
        conn, cfg["window_days"], batch_size * ceiling, stamp, force,
        since=floor_for(cfg, cfg["window_days"], stamp))

    return _run_batches(conn, rows, batch_size, EVENT_FIELDS, glossary, run,
                        stamp, _write_event, _record_event_failure)


DEFAULT_TRANSLATOR = "codex"


class DocBudget:
    """A per-run ceiling on the model calls the document pass may make.

    Rows and events are bounded by `max_batches_per_run`; documents were
    bounded by nothing. HISTORY, not current behaviour: before `DocLedger`,
    one document the translator always refuses cost a call every tick — 144 a
    day, indefinitely. That part is now fixed upstream of the budget, by the
    attempt cap; a permanently-refused document costs three calls and stops.
    What remains, and what this class is still for, is the SHAPE of a single
    tick: the first run after a deploy still wants one serial call per line of
    the append-only predictions file plus one per pending report, and at
    `timeout_seconds: 180` that is hours of work offered to a unit that fires
    every ten minutes.

    The ceiling spans the WHOLE pass — stance sections, playbook, watchlist
    entries, prediction lines and reports together — because the cost that
    matters is the tick's, not any one document's. Whatever is left over is
    simply picked up next tick, exactly like the rows backlog.

    A limit of None is no ceiling, which is what every caller that does not
    configure one gets — and what `--force` gets deliberately, for the reason
    written out in `translate_docs`.
    """

    def __init__(self, limit: int | None = None):
        self.limit = limit
        self.remaining = limit
        self.skipped = 0
        self.oversize_taken = False

    def take(self, n: int = 1) -> bool:
        """Claim `n` calls for ONE unit. False when this tick cannot cover it.

        All or nothing per unit, because a large document is translated in
        pieces and half a document is not a document: writing it would put
        Persian sections beside English ones under a hash claiming both were
        translated.

        A unit needing more calls than the WHOLE ceiling is let through
        anyway — ONCE per run, and only from a budget nothing has spent yet.
        It can never fit, so refusing it forever is not a deferral, it is
        permanent starvation reported as "deferred to the next tick": a 60KB
        report would sit English while the summary implied it was queued.

        Both halves of that guard are load-bearing, and the unguarded version
        shipped first. `DocBudget(10)` then five `take(15)` calls returned
        True five times and counted nothing skipped — 75 calls, 3.75 hours at
        timeout_seconds 180, against a TimeoutStartSec of 2,400 seconds.
        systemd does not bound that run, it KILLS it: the sidecars are never
        written, no ledger row is recorded (a SIGTERM is not a ModelError),
        and the next tick starts over identically. That is the same
        forever-loop DocLedger exists to end. Nor is the shape exotic — every
        `## ` section is at least one chunk, so a 10KB document of 30 short
        sections wants 31 chunks while being smaller than a brief that used
        to translate in a single call.

        So: one oversized unit per tick, taken before anything else has been
        paid for, and the rest of the tick is then spent. A second oversized
        unit, or one arriving after ordinary spending, waits for the next
        tick like any other deferral — which it will get, because nothing
        else can be spending an untouched budget ahead of it forever.
        """
        if self.remaining is None:
            return True
        if n > self.limit:
            # `remaining == limit` is "nothing spent yet"; `limit` itself
            # must be non-zero, or a ceiling of 0 — no document calls at all
            # this tick — would read as room for an unbounded one.
            if self.oversize_taken or self.remaining != self.limit or not self.limit:
                self.skipped += 1
                return False
            self.oversize_taken = True
            self.remaining = 0
            return True
        if self.remaining < n:
            self.skipped += 1
            return False
        self.remaining -= n
        return True


def _int_setting(cfg: dict, key: str, default: int | None) -> int | None:
    """`cfg[key]` as an int, or `default` if it is missing, empty or garbage.

    YAML reads `doc_chunk_bytes:` with nothing after it as None, and
    `len(text) <= None` is a TypeError that takes the whole document pass
    down — stance, playbook, watchlist, predictions and every pending report
    with it. That spelling is not a stretch: `translate_from:` three lines
    above it in the same block uses exactly an empty value to mean "unset",
    so an operator will write it that way sooner or later. `floor_for`
    already tolerates the analogous typo for a date, for the same reason — a
    config typo must not take the pass down at the first tick.

    A value that is present but unreadable (`max_doc_calls_per_run: ten`)
    takes the same path rather than raising. It degrades to whatever the key
    means when absent, which for the ceiling is "no ceiling" — deliberately,
    because that is what the key has always meant when missing and a
    surprising ceiling is harder to diagnose than a missing one.

    Booleans are rejected explicitly: `int(True)` is 1, and a chunk
    threshold of one byte would be a far stranger failure than falling back.
    """
    raw = cfg.get(key, default)
    if raw is None or isinstance(raw, bool):
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


# Above this many bytes of UTF-8 source, a document is translated in pieces
# rather than in one call.
#
# MEASURED ON THE LIVE HOST, 2026-09-14..16, at translate.timeout_seconds 180:
#
#   2026-09-14-brief.md  11,362 bytes  -> succeeded
#   2026-09-15-brief.md  11,455 bytes  -> succeeded
#   2026-09-16-brief.md  21,728 bytes  -> FAILED: translator timed out
#
# Everything above roughly 12,000 bytes timed out the same way, and the
# pending reports ran 19,767 to 26,968 bytes — so not one of them could ever
# have succeeded. A two-hour --force run produced zero new report sidecars
# while burning a call per attempt.
#
# 8,000 rather than 12,000, because 12,000 is where it BROKE, not where it is
# safe. The two documents that did succeed were within 5% of the break, and a
# 180-second wall clock moves with model load, so a threshold at the observed
# edge would time out on a slow afternoon. Two-thirds of the break point puts
# a chunk well inside the envelope that demonstrably worked, while still
# leaving the largest real section anyone has written — the 8,434-byte FOMC
# deep dive of 2026-09-16 — a two-chunk split rather than a twenty-chunk one.
#
# Raising it trades safety for fewer calls; lowering it trades calls for
# safety. Both are bounded by max_doc_calls_per_run, which counts CHUNKS.
DEFAULT_CHUNK_BYTES = 8000

# What a document may fail before it stops being attempted, mirroring
# MAX_ATTEMPTS for rows. Combined with BACKOFF_MINUTES (shared with the rows
# pass, for the reason written out there) a document's attempts land at t+0,
# t+15 and t+75: long enough to ride out a restart or a short auth wobble,
# and short enough that a permanently-refused document costs three calls
# rather than ~144 a day forever.
MAX_DOC_ATTEMPTS = 3


class DocLedger:
    """Attempt counter, backoff and abandonment for documents (docs/todo/019).

    Rows and events carry `fa_attempts` on their own database row. Documents
    are files on disk with no row anywhere, and the sidecar records only what
    SUCCEEDED — so a document the translator refuses was offered again every
    tick, indefinitely. At max_doc_calls_per_run 10 on a 10-minute timer that
    is ~1,440 wasted calls a day, each able to tie up 180 seconds.

    The state lives in the `doc_translations` table; `jamasp/db.py` carries
    the argument for a table over a `meta` key per document. A row exists only
    while a unit is failing, so the table is normally empty.

    A "unit" is the smallest thing that is translated in one decision: a whole
    report or playbook, but one stance SECTION, one watchlist theme, one
    prediction line — matching how each pass already decides what to retry.

    The counter is tied to the English it was earned against. When a unit's
    source changes, its record no longer applies and the unit is offered again
    from zero: stance.md is rewritten at the end of every agent run, and an
    abandonment that outlived its text would silently freeze a section in
    English for good.
    """

    def __init__(self, conn: sqlite3.Connection, root: Path,
                 now: str | None = None):
        self.conn = conn
        self.root = root
        self.now = now or utcnow()

    def key(self, source: Path, sub: str = "") -> str:
        """`path/relative/to/root` plus `#<sub-unit>` where a file has parts.

        Relative to the repo root so the ledger survives the checkout moving,
        and so a second checkout pointed at a copy of the database reads the
        same units rather than a disjoint set of absolute paths.
        """
        try:
            rel = source.relative_to(self.root).as_posix()
        except ValueError:
            rel = source.name
        return f"{rel}#{sub}" if sub else rel

    def state(self, source: Path, digest: str, sub: str = "") -> str:
        """`'ready'`, `'backoff'` or `'abandoned'` for one unit.

        `'backoff'` and `'abandoned'` both mean "do not attempt this now" and
        differ only in what the operator is told: a backed-off unit is coming
        back on a later tick, an abandoned one is not coming back without
        `--force`.
        """
        row = self.conn.execute(
            "SELECT src_hash, attempts, failed_at FROM doc_translations"
            " WHERE unit = ?", (self.key(source, sub),),
        ).fetchone()
        if row is None or row["src_hash"] != digest:
            return "ready"
        if row["attempts"] >= MAX_DOC_ATTEMPTS:
            return "abandoned"
        # The same delays the rows pass uses, indexed by the attempt just
        # spent. ELSE-style clamping for the same reason as `_backoff`: a
        # raised MAX_DOC_ATTEMPTS without a longer tuple should back a unit
        # off further, never let it retry on every tick.
        delay = BACKOFF_MINUTES[min(row["attempts"], len(BACKOFF_MINUTES)) - 1]
        failed = datetime.strptime(row["failed_at"], "%Y-%m-%dT%H:%M:%SZ")
        current = datetime.strptime(self.now, "%Y-%m-%dT%H:%M:%SZ")
        return "backoff" if current < failed + timedelta(minutes=delay) else "ready"

    def record_failure(self, source: Path, digest: str, error: str,
                       sub: str = "") -> None:
        """Count one failed attempt against this unit's current English."""
        self.conn.execute(
            "INSERT INTO doc_translations"
            " (unit, src_hash, attempts, last_error, failed_at)"
            " VALUES (?, ?, 1, ?, ?)"
            " ON CONFLICT(unit) DO UPDATE SET"
            "   attempts = CASE WHEN doc_translations.src_hash ="
            "                        excluded.src_hash"
            "                   THEN doc_translations.attempts + 1"
            "                   ELSE 1 END,"
            "   src_hash = excluded.src_hash,"
            "   last_error = excluded.last_error,"
            "   failed_at = excluded.failed_at",
            (self.key(source, sub), digest, error[:500], self.now),
        )
        self.conn.commit()

    def clear(self, source: Path, sub: str = "") -> None:
        """Forget a unit that translated. Keeps the table to what is broken."""
        self.conn.execute("DELETE FROM doc_translations WHERE unit = ?",
                          (self.key(source, sub),))
        self.conn.commit()

    def clear_all(self) -> None:
        """`--force`'s document half, the analogue of `rearm` for rows.

        Everything, not just the units this run will visit: the spec's escape
        hatch is "an operator clearing a known-bad state does not have to edit
        the database", and a row left behind for a report that has since been
        deleted would never be cleared by anything else.
        """
        self.conn.execute("DELETE FROM doc_translations")
        self.conn.commit()


def _doc_counts(translated: int = 0, failed: int = 0, abandoned: int = 0,
                backoff: int = 0) -> dict:
    """The shape every document pass returns, so `translate_docs` can sum it.

    `failed`, `abandoned` and `backoff` are deliberately separate numbers.
    "3 documents failed this run", "3 documents are being skipped because
    they keep failing" and "3 documents are waiting out a backoff before
    their next attempt" are three different operator situations, and only the
    first two involve anything going wrong in THIS tick.

    `backoff` is here because it was in none of them at first: a backed-off
    unit was counted in nothing, so a tick where every document was waiting
    printed `docs 0/0` — byte-identical to a tick with nothing to do.
    """
    return {"translated": translated, "failed": failed,
            "abandoned": abandoned, "backoff": backoff}


def _translate_text(text: str, glossary: dict, run) -> str:
    """One model call for one document or section."""
    prompt = translatetext.build_doc_prompt(text, glossary)
    return translatetext.parse_doc_response(
        run(prompt, translatetext.doc_schema())
    )


def translate_stance(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, translator: str = DEFAULT_TRANSLATOR,
    force: bool = False, budget: DocBudget | None = None,
    ledger: DocLedger | None = None,
) -> dict:
    """Translate stance.md section by section into its sidecar.

    Per-section hashing because a brief run usually rewrites one section and
    leaves five alone; hashing the whole file would pay for all six every day.

    A section that fails keeps whatever Persian it already had, and the sidecar
    is rewritten only when something actually changed — so a total failure
    leaves the previous file byte-identical rather than half-updated. A section
    that has no Persian to keep falls back to its English body, and the
    front-matter hash then deliberately does not match the source; see the
    comment above the write.
    """
    if not source.exists():
        return _doc_counts()

    text = source.read_text(encoding="utf-8")
    # The front matter carries the hash of the WHOLE English file; the comment
    # lines carry the per-section hashes. The panel compares the front-matter
    # one against stance.md beside it and treats a mismatch as no sidecar, so
    # this is what decides whether the Persian stance renders at all.
    whole = translatetext.src_hash(text)

    prior: list[tuple[str, str, str]] = []
    prior_meta: dict[str, str] = {}
    if sidecar.exists():
        raw = sidecar.read_text(encoding="utf-8")
        prior_meta, _ = translatetext.parse_front_matter(raw)
        prior = translatetext.parse_stance_sidecar(raw)
    existing = {heading: (h, body) for heading, h, body in prior}

    translated = failed = abandoned = backoff = 0
    out: list[tuple[str, str, str]] = []
    for heading, body in translatetext.split_sections(text):
        digest = translatetext.src_hash(body)
        previous = existing.get(heading)
        if not force and previous and previous[0] == digest:
            out.append((heading, digest, previous[1]))
            continue
        if not body.strip():
            out.append((heading, digest, body))
            continue
        # A section is a unit of its own in the ledger, the same way it is a
        # unit of its own for hashing: one section the translator refuses must
        # not abandon the other five. Checked BEFORE the budget, so a section
        # nobody will attempt cannot spend a call slot another section wanted.
        state = (ledger.state(source, digest, heading or "(preamble)")
                 if ledger else "ready")
        if state != "ready":
            # Identical bookkeeping to the budget path below — keep whatever
            # Persian this section had and its OLD hash, so nothing claims it
            # is current. The count is the only difference, and only so the
            # summary can say which of the two happened.
            if state == "abandoned":
                abandoned += 1
            else:
                backoff += 1
            out.append((heading,
                        previous[0] if previous else "",
                        previous[1] if previous else body))
            continue
        if budget is not None and not budget.take():
            # Out of calls for this tick. Keep whatever Persian this section
            # had and — crucially — its OLD hash, so the next tick sees it as
            # still pending. Same shape as the failure path below, but not a
            # failure: nothing went wrong, the tick simply ended.
            out.append((heading,
                        previous[0] if previous else "",
                        previous[1] if previous else body))
            continue
        try:
            persian = _translate_text(body, glossary, run)
        except modelrun.QuotaExhausted:
            # Unlike an ordinary failure, this is not "this section is bad" —
            # every remaining section (and the rest of the docs pass behind
            # it) would fail the same way. Raise straight out without
            # appending anything for this section or writing the sidecar:
            # the sections done so far in THIS call are simply retried, at no
            # extra cost, on the next tick that finds codex funded again.
            #
            # The ledger is deliberately untouched here: a quota outage is not
            # this section's fault, and counting it would walk every section
            # to the cap during an outage nobody could have avoided.
            raise
        except (modelrun.ModelError, translatetext.ParseError) as exc:
            # Keep the previous Persian for this section, and keep its OLD
            # hash so the next run tries again rather than believing it is done.
            if ledger:
                ledger.record_failure(source, digest, str(exc),
                                      heading or "(preamble)")
            out.append((
                heading,
                previous[0] if previous else "",
                previous[1] if previous else body,
            ))
            failed += 1
        else:
            if ledger:
                ledger.clear(source, heading or "(preamble)")
            out.append((heading, digest, persian))
            translated += 1

    # The whole-file hash goes in the front matter only when every section
    # actually carries Persian. A section that failed, was deferred, or was
    # abandoned by the attempt cap, with no previous translation to keep, is
    # written out as its ENGLISH body under an empty per-section hash (the
    # three paths above) — and an empty per-section hash is
    # the only way one occurs, since sha256 of even an empty body is not empty.
    # Stamping the real hash over that would tell the panel the sidecar is
    # current, and PR 2's reader would render English text as Persian with no
    # EN marker. A non-matching hash makes the reader fall back to English
    # wholesale, marker and all, until the next tick fills the section in.
    #
    # Stale PERSIAN is the other degraded state and it keeps the real hash on
    # purpose: the sections still match the source in count and order, so one
    # stale section is better than dropping the whole panel, and its preserved
    # per-section hash keeps it queued. Do not conflate the two.
    stamp = "" if any(not h for _, h, _ in out) else whole

    # Written when the computed sidecar differs from the one on disk, NOT when
    # something was translated. A stance edit that merely empties a section, or
    # drops one while leaving the rest byte-identical, translates nothing — and
    # would otherwise leave the sidecar with a stale body and a stale section
    # COUNT. The panel matches sidecar bodies to source sections by order, so a
    # count mismatch degrades the whole Stance panel to English.
    #
    # The second clause restamps the front matter when the sections are already
    # current but the whole-file hash on disk is not. It is guarded on `not
    # failed` so a run where EVERY section failed still leaves the previous
    # file byte-identical: that sidecar does not reflect this source, and
    # stamping it with this source's hash would present stale Persian as
    # current. A partial failure does rewrite — the succeeded sections are
    # worth having — and the failed section keeps its old hash, so it retries.
    if out != prior or (not failed and prior_meta.get("src_hash") != stamp):
        translatetext.write_atomic(
            sidecar,
            translatetext.render_stance_sidecar(
                out, now or utcnow(), translator, stamp),
        )
    return _doc_counts(translated, failed, abandoned, backoff)


def translate_document(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, translator: str = DEFAULT_TRANSLATOR,
    force: bool = False, budget: DocBudget | None = None,
    chunk_bytes: int = DEFAULT_CHUNK_BYTES, ledger: DocLedger | None = None,
) -> dict:
    """Whole-document sidecar: playbook and reports.

    Nothing parses these structurally, so a document that fits in one call
    still goes in one call, headings included. A LARGE one does not: measured
    on the live host, a 21,728-byte brief timed the translator out after 180
    seconds where 11,362 and 11,455-byte ones succeeded, and every pending
    report was bigger than the ones that failed — so the whole-document path
    could never have finished a single one of them. Above
    `chunk_bytes` (see DEFAULT_CHUNK_BYTES for the measurements) the document
    is cut into segments at its `## ` headings, and inside an over-large
    section at blank lines, and reassembled around the untranslated
    structure — so what comes back differs from the source in its prose and
    in nothing else.

    A failure leaves the existing sidecar byte-identical: a stale Persian
    document is better than none, and the hash mismatch is what keeps the
    panel honest about it.
    """
    if not source.exists():
        return _doc_counts()
    text = source.read_text(encoding="utf-8")
    digest = translatetext.src_hash(text)

    if not force and sidecar.exists():
        meta, _ = translatetext.parse_front_matter(
            sidecar.read_text(encoding="utf-8"))
        if meta.get("src_hash") == digest:
            return _doc_counts()

    # Before the budget: a document nobody is going to attempt must not spend
    # a call slot that another document could have used.
    state = ledger.state(source, digest) if ledger else "ready"
    if state != "ready":
        return _doc_counts(abandoned=int(state == "abandoned"),
                           backoff=int(state == "backoff"))

    # Only documents over the threshold are cut up. Chunking a 2KB playbook
    # into a single chunk buys nothing and adds a reassembly step that can be
    # wrong; below the threshold this is byte-for-byte the old single call.
    segments = (
        [("", text, "")] if len(text.encode("utf-8")) <= chunk_bytes
        else translatetext.doc_segments(text, chunk_bytes)
    )
    # Reserved together, not one at a time: a document abandoned halfway
    # through because the tick ran out of budget would have paid for the
    # chunks it did translate and thrown them away.
    wanted = sum(1 for _, prose, _ in segments if prose)

    # Checked after the hash, so an unchanged document costs no budget.
    if budget is not None and not budget.take(wanted):
        return _doc_counts()

    parts: list[str] = []
    try:
        for before, prose, after in segments:
            parts.append(before)
            if prose:
                parts.append(_translate_text(prose, glossary, run))
            parts.append(after)
    except modelrun.QuotaExhausted:
        raise   # see translate_stance's comment on the same exception
    except (modelrun.ModelError, translatetext.ParseError) as exc:
        # The chunks already translated in THIS call are discarded rather
        # than written beside untranslated English under a hash that claims
        # the whole document is Persian. The same trade translate_stance
        # makes when it loses the sections it had already done.
        if ledger:
            ledger.record_failure(source, digest, str(exc))
        return _doc_counts(failed=1)

    if ledger:
        ledger.clear(source)
    translatetext.write_atomic(
        sidecar,
        translatetext.render_front_matter(digest, now or utcnow(), translator)
        + "".join(parts),
    )
    return _doc_counts(translated=1)


def translate_watchlist(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, force: bool = False,
    budget: DocBudget | None = None, ledger: DocLedger | None = None,
) -> dict:
    """Sidecar keyed by theme, carrying only Persian and a hash.

    The English `why` is deliberately not copied across: duplicating it would
    create a second copy that drifts the moment a brief rewrites the original.
    """
    if not source.exists():
        return _doc_counts()
    entries = (yaml.safe_load(source.read_text(encoding="utf-8")) or {}).get(
        "watchlist") or []

    existing = {}
    if sidecar.exists():
        prior = (yaml.safe_load(sidecar.read_text(encoding="utf-8")) or {}).get(
            "watchlist") or []
        existing = {e.get("theme"): e for e in prior}

    translated = failed = abandoned = backoff = 0
    out = []
    for entry in entries:
        theme, why = entry.get("theme", ""), entry.get("why", "")
        digest = translatetext.src_hash(why)
        previous = existing.get(theme)
        if not force and previous and previous.get("src_hash") == digest:
            out.append(previous)
            continue
        # One theme is one unit: see translate_stance for why the ledger is
        # consulted ahead of the budget.
        state = ledger.state(source, digest, theme) if ledger else "ready"
        if state != "ready":
            if state == "abandoned":
                abandoned += 1
            else:
                backoff += 1
            if previous:
                out.append(previous)
            continue
        if budget is not None and not budget.take():
            if previous:
                out.append(previous)      # stale, and still pending next tick
            continue
        try:
            why_fa = _translate_text(why, glossary, run)
        except modelrun.QuotaExhausted:
            raise   # see translate_stance's comment on the same exception
        except (modelrun.ModelError, translatetext.ParseError) as exc:
            if ledger:
                ledger.record_failure(source, digest, str(exc), theme)
            if previous:
                out.append(previous)
            failed += 1
        else:
            if ledger:
                ledger.clear(source, theme)
            out.append({"theme": theme, "why_fa": why_fa,
                        "src_hash": digest})
            translated += 1

    # Same rule as stance: compare the computed file with the one on disk, so
    # a theme removed from watchlist.yaml is removed here too. A run where
    # everything failed reproduces the previous file exactly and writes
    # nothing.
    text = yaml.safe_dump({"watchlist": out}, allow_unicode=True,
                          sort_keys=False)
    if not sidecar.exists() or sidecar.read_text(encoding="utf-8") != text:
        translatetext.write_atomic(sidecar, text)
    return _doc_counts(translated, failed, abandoned, backoff)


def translate_predictions(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, force: bool = False,
    budget: DocBudget | None = None, ledger: DocLedger | None = None,
) -> dict:
    """Sidecar keyed by prediction id, one JSON object per line.

    A sidecar rather than a `claim_fa` field in the source because
    `jamasp predictions add` appends to that file; rewriting it here would race
    an append and could lose a prediction.
    """
    if not source.exists():
        return _doc_counts()

    existing = {}
    if sidecar.exists():
        for line in sidecar.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                existing[row.get("id")] = row

    translated = failed = abandoned = backoff = 0
    out = []
    for line in source.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue   # an interrupted append; the source reader skips it too
        pid, claim = row.get("id"), row.get("claim", "")
        digest = translatetext.src_hash(claim)
        previous = existing.get(pid)
        if not force and previous and previous.get("src_hash") == digest:
            out.append(previous)
            continue
        # One prediction line is one unit: see translate_stance for why the
        # ledger is consulted ahead of the budget.
        state = ledger.state(source, digest, pid) if ledger else "ready"
        if state != "ready":
            if state == "abandoned":
                abandoned += 1
            else:
                backoff += 1
            if previous:
                out.append(previous)
            continue
        if budget is not None and not budget.take():
            if previous:
                out.append(previous)
            continue
        try:
            claim_fa = _translate_text(claim, glossary, run)
        except modelrun.QuotaExhausted:
            raise   # see translate_stance's comment on the same exception
        except (modelrun.ModelError, translatetext.ParseError) as exc:
            if ledger:
                ledger.record_failure(source, digest, str(exc), pid)
            if previous:
                out.append(previous)
            failed += 1
        else:
            if ledger:
                ledger.clear(source, pid)
            out.append({"id": pid, "claim_fa": claim_fa,
                        "src_hash": digest})
            translated += 1

    text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in out)
    if not sidecar.exists() or sidecar.read_text(encoding="utf-8") != text:
        translatetext.write_atomic(sidecar, text)
    return _doc_counts(translated, failed, abandoned, backoff)


def new_reports(reports_dir: Path, since_iso: str) -> list[Path]:
    """Reports dated on or after `since_iso` that have no sidecar yet.

    Spec decision 18: new reports only. The archive behind the ship date stays
    English, which is arguably correct — those briefs were written in English.
    """
    if not reports_dir.exists():
        return []
    out = []
    for path in sorted(reports_dir.rglob("*.md")):
        if path.name.endswith(".fa.md"):
            continue
        if path.name[:10] < since_iso[:10]:
            continue
        if not path.with_name(path.name[:-3] + ".fa.md").exists():
            out.append(path)
    return out


def translate_docs(
    root: Path, cfg: dict, glossary: dict, run,
    now: str | None = None, force: bool = False,
    conn: sqlite3.Connection | None = None,
) -> dict:
    """Every document sidecar, in one pass. Returns summed counts.

    `root` rather than hard-coded paths so a test can build a whole state tree
    in tmp_path — and so a second checkout is never at risk of writing into the
    live one.

    `conn` is only for the attempt ledger — every write this pass makes is to
    a file. Passing `None` leaves the pass as it was before docs/todo/019 was
    fixed, with no per-document cap at all; it is what a test about something
    else passes, never production. `run_translate` always hands over the live
    connection, and `test_run_translate_wires_the_document_ledger` is what
    keeps that true.
    """
    state, reports = root / "state", root / "reports"
    totals = {"translated": 0, "failed": 0, "abandoned": 0, "backoff": 0}
    ledger = DocLedger(conn, root, now) if conn is not None else None
    if ledger is not None and force:
        # --force's document half, mirroring `rearm` for rows: the spec's
        # escape hatch is "an operator clearing a known-bad state does not
        # have to edit the database", and an abandoned document is exactly
        # such a state.
        ledger.clear_all()
    # Chunking threshold, named and configurable rather than a magic number.
    # Absent, empty or unreadable means the measured default — NOT "never
    # chunk", which is the bug this key exists to fix. See `_int_setting`.
    chunk_bytes = _int_setting(cfg, "doc_chunk_bytes", DEFAULT_CHUNK_BYTES)
    # One budget across every document type: the ceiling that matters is the
    # tick's total, not any single file's. See DocBudget.
    #
    # --force deliberately has NO ceiling, and this is load-bearing rather than
    # an oversight — do not "fix" it back. Force skips the hash check, so a
    # unit it defers is written back carrying its CURRENT hash and the next
    # ordinary tick sees it as up to date: the intent "retranslate even though
    # nothing changed" lives only in this run and is lost the moment the budget
    # refuses. An operator who edits config/glossary.fa.yaml and runs --force
    # would re-gloss the first `max_doc_calls_per_run` units, be told the rest
    # were queued, and never reach them however many times they ran it. In
    # ORDINARY operation there is no such trap: a deferred unit keeps its OLD
    # hash, which still differs from the source, so it is correctly retried.
    #
    # The ceiling exists to bound an UNATTENDED timer tick. The timer never
    # passes --force; --force is an attended operator action, and the unit's
    # TimeoutStartSec does not constrain a manual invocation either.
    budget = DocBudget(
        None if force else _int_setting(cfg, "max_doc_calls_per_run", None))

    def merge(result):
        totals["translated"] += result["translated"]
        totals["failed"] += result["failed"]
        totals["abandoned"] += result["abandoned"]
        totals["backoff"] += result["backoff"]

    # Each of the four calls below (and each report in the loop) can raise
    # modelrun.QuotaExhausted from inside its own per-item loop — see the
    # `raise` beside every `except modelrun.QuotaExhausted` upstream. One
    # try/except around the whole chain, rather than one per call, because
    # the point is the same as translate_rows/translate_events: stop at the
    # FIRST one, not after paying to discover it again in playbook,
    # watchlist, predictions and every pending report in turn.
    try:
        merge(translate_stance(state / "stance.md", state / "stance.fa.md",
                               glossary, run, now, force=force, budget=budget,
                               ledger=ledger))
        merge(translate_document(state / "playbook.md", state / "playbook.fa.md",
                                 glossary, run, now, force=force, budget=budget,
                                 chunk_bytes=chunk_bytes, ledger=ledger))
        merge(translate_watchlist(state / "watchlist.yaml",
                                  state / "watchlist.fa.yaml",
                                  glossary, run, now, force=force, budget=budget,
                                  ledger=ledger))
        merge(translate_predictions(state / "predictions.jsonl",
                                    state / "predictions.fa.jsonl",
                                    glossary, run, now, force=force, budget=budget,
                                    ledger=ledger))
        for report in new_reports(reports, cfg["reports_since"]):
            merge(translate_document(
                report, report.with_name(report.name[:-3] + ".fa.md"),
                glossary, run, now, force=force, budget=budget,
                chunk_bytes=chunk_bytes, ledger=ledger))
    except modelrun.QuotaExhausted as exc:
        totals["quota_exhausted"] = True
        totals["quota_message"] = str(exc)
    totals["skipped"] = budget.skipped
    return totals


REQUIRED_CFG_KEYS = (
    "cmd", "protocol", "timeout_seconds",
    "window_days", "batch_size", "max_batches_per_run", "reports_since",
)


def check(cfg: dict) -> str | None:
    """Preflight: config complete, protocol known, binary present.

    The codex analogue of the Claude credentials trap in CLAUDE.md. A run whose
    auth has lapsed fails every batch identically while still exiting zero, so
    an operator needs a way to ask "is this even wired up?" that does not
    involve reading the journal.
    """
    missing = [k for k in REQUIRED_CFG_KEYS if k not in cfg]
    if missing:
        return f"settings.yaml translate: missing {', '.join(missing)}"
    if cfg["protocol"] not in modelrun.PROTOCOLS:
        return (f"settings.yaml translate.protocol {cfg['protocol']!r} unknown;"
                f" expected one of {modelrun.PROTOCOLS}")
    binary = (cfg["cmd"] or [""])[0]
    if not binary or shutil.which(binary) is None:
        return (f"translator {binary!r} is not on PATH —"
                " install it, or point translate.cmd elsewhere")
    return None


def run_translate(
    conn: sqlite3.Connection, settings: dict, root: Path = Path("."),
    glossary: dict | None = None, run=None, now: str | None = None,
    dry_run: bool = False, force: bool = False, only: str | None = None,
) -> dict:
    """One full pass. Returns per-pass counts for the CLI to print."""
    cfg = settings["translate"]
    if glossary is None:
        glossary = config_mod.load_glossary()
    if run is None:
        def run(prompt, schema):
            return modelrun.run_json(
                cfg["cmd"], cfg["protocol"], prompt, schema,
                cfg["timeout_seconds"])

    want_rows = only in (None, "rows")
    want_events = only in (None, "events")
    want_docs = only in (None, "docs")

    if dry_run:
        return {
            "dry_run": True,
            "pending_rows": len(pending_rows(
                conn, cfg["window_days"],
                cfg["batch_size"] * cfg["max_batches_per_run"], now, force,
                since=floor_for(cfg, cfg["window_days"], now),
                scored_only=cfg.get("scored_only", False))),
            "pending_events": len(pending_events(
                conn, cfg["window_days"],
                cfg["batch_size"] * cfg["max_batches_per_run"], now, force,
                since=floor_for(cfg, cfg["window_days"], now))),
            "pending_reports": len(new_reports(root / "reports", cfg["reports_since"])),
        }

    stats: dict = {"reused": 0, "rows": {}, "events": {}, "docs": {}}
    # A quota outage found in one pass means every remaining pass would hit
    # the same wall — codex does not distinguish rows from events from docs,
    # it is simply out of allowance — so `quota_hit` short-circuits the rest
    # of this run the moment any pass reports it, rather than paying to
    # rediscover the outage in events and again in docs (docs/todo/025).
    quota_hit = False
    if want_rows:
        # Always before the model pass, and not separately selectable: a rows
        # pass that ran first would pay to translate what flash already wrote.
        stats["reused"] = reuse_flash_persian(conn, now)
        stats["rows"] = translate_rows(conn, cfg, glossary, run, now, force)
        quota_hit = bool(stats["rows"].get("quota_exhausted"))
    if want_events and not quota_hit:
        stats["events"] = translate_events(conn, cfg, glossary, run, now, force)
        quota_hit = bool(stats["events"].get("quota_exhausted"))
    if want_docs and not quota_hit:
        stats["docs"] = translate_docs(root, cfg, glossary, run, now, force,
                                       conn=conn)
        quota_hit = quota_hit or bool(stats["docs"].get("quota_exhausted"))
    if quota_hit:
        stats["quota_exhausted"] = True

    # Evidence that the job runs on this host, mirroring meta.last_ingest_at.
    # The watchdog's backlog and abandoned probes gate on this rather than on
    # the `translate:` config block: the block ships enabled-looking while the
    # timer stays disabled until host volume is measured, and probing on
    # configuration alone alerts the desk about a job nobody has asked to run.
    # Written even when nothing was translated — the claim is "it ran", not "it
    # did work" — and never by --dry-run, which is an inspection.
    #
    # An `--only` run stamps too: it is still the job running, and the alt —
    # a partial run leaving the probes disarmed — would be a quieter watchdog
    # for an operator action that is rare and deliberate either way.
    set_meta(conn, "last_translate_at", now or utcnow())
    return stats
