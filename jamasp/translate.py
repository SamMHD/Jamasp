"""Fill Persian renderings of everything the panel renders.

Four passes: a free SQL copy of Persian the flash pipeline already wrote, two
batched model passes over `items` and `events`, and a sidecar pass over the
documents agent runs write. Presentation only — no analysis run ever reads
Persian, and nothing here touches Telegram.

Runs on its own timer, never wrapped by `jamasp run`, so it consumes none of
the daily agent-run cap.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Sequence

import yaml

from jamasp import modelrun, translatetext
from jamasp.db import utcnow


def reuse_flash_persian(conn: sqlite3.Connection, now: str | None = None) -> int:
    """Copy Persian from delivered flashes into `items`. No model calls.

    Runs before the model pass, and the order is load-bearing: every top- and
    middle-tier story already has Persian written for the news channel, and a
    rows pass that ran first would pay to translate it a second time — and
    produce a second, different Persian headline for the same story.

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


def pending_rows(
    conn: sqlite3.Connection, window_days: int, limit: int,
    now: str | None = None,
) -> list[sqlite3.Row]:
    """Untranslated items inside the window, newest first.

    Newest first is the priority order that matters: the freshest headline is
    the one somebody is looking at, and a backlog larger than a tick's ceiling
    drains from the top over subsequent ticks.

    The attempt cap is applied here rather than at write time so an abandoned
    row costs nothing to skip — it never enters a batch again.
    """
    return conn.execute(
        "SELECT id, headline, lede FROM items"
        " WHERE headline_fa IS NULL AND published_at >= ? AND fa_attempts < ?"
        " ORDER BY published_at DESC LIMIT ?",
        (_since(window_days, now), MAX_ATTEMPTS, limit),
    ).fetchall()


def _write_row(conn, item_id: str, entry: dict, now: str) -> None:
    conn.execute(
        "UPDATE items SET headline_fa = ?, lede_fa = ?, fa_source = 'model',"
        " fa_at = ?, fa_error = NULL WHERE id = ?",
        (entry["headline"], entry.get("lede"), now, item_id),
    )


def _record_failure(conn, item_id: str, error: str) -> None:
    conn.execute(
        "UPDATE items SET fa_attempts = fa_attempts + 1, fa_error = ?"
        " WHERE id = ?",
        (error[:500], item_id),
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


def _batch_with_fallback(
    conn, rows, fields, glossary, run, now, write, fail
) -> tuple[int, int]:
    """Translate one batch: try it, retry once, then one call per row.

    A malformed or refused response costs the whole batch, so one bad headline
    must not be allowed to poison nineteen good ones.
    """
    for attempt in (1, 2):
        try:
            answers = _translate_batch(rows, fields, glossary, run)
        except (modelrun.ModelError, translatetext.ParseError):
            if attempt == 2:
                break
            continue
        translated = 0
        for position, row in enumerate(rows):
            entry = answers.get(position)
            if entry:
                write(conn, row["id"], entry, now)
                translated += 1
            else:
                fail(conn, row["id"], "model omitted this entry")
        conn.commit()
        return translated, len(rows) - translated

    translated = 0
    for row in rows:
        try:
            answers = _translate_batch([row], fields, glossary, run)
        except (modelrun.ModelError, translatetext.ParseError) as exc:
            fail(conn, row["id"], str(exc))
            continue
        entry = answers.get(0)
        if entry:
            write(conn, row["id"], entry, now)
            translated += 1
        else:
            fail(conn, row["id"], "model omitted this entry")
    conn.commit()
    return translated, len(rows) - translated


def translate_rows(
    conn: sqlite3.Connection, cfg: dict, glossary: dict,
    run: Callable[[str, dict], object], now: str | None = None,
) -> dict:
    """Translate pending items in batches. Returns counts."""
    stamp = now or utcnow()
    batch_size = cfg["batch_size"]
    ceiling = cfg["max_batches_per_run"]
    rows = pending_rows(conn, cfg["window_days"], batch_size * ceiling, now)

    translated = failed = batches = 0
    for start in range(0, len(rows), batch_size):
        chunk = rows[start:start + batch_size]
        ok, bad = _batch_with_fallback(
            conn, chunk, ROW_FIELDS, glossary, run, stamp,
            _write_row, _record_failure,
        )
        translated += ok
        failed += bad
        batches += 1
    return {"translated": translated, "failed": failed, "batches": batches}


EVENT_FIELDS = ("title",)


def pending_events(
    conn: sqlite3.Connection, window_days: int, limit: int,
    now: str | None = None,
) -> list[sqlite3.Row]:
    """Untranslated events from the recent past forward, soonest first.

    No upper bound: the calendar is a forward-looking view, so every future
    event qualifies. The window only bounds how far back a just-passed event
    stays worth translating.
    """
    return conn.execute(
        "SELECT id, title FROM events"
        " WHERE title_fa IS NULL AND starts_at >= ? AND fa_attempts < ?"
        " ORDER BY starts_at LIMIT ?",
        (_since(window_days, now), MAX_ATTEMPTS, limit),
    ).fetchall()


def _write_event(conn, event_id: str, entry: dict, now: str) -> None:
    conn.execute(
        "UPDATE events SET title_fa = ?, fa_at = ?, fa_error = NULL WHERE id = ?",
        (entry["title"], now, event_id),
    )


def _record_event_failure(conn, event_id: str, error: str) -> None:
    conn.execute(
        "UPDATE events SET fa_attempts = fa_attempts + 1, fa_error = ?"
        " WHERE id = ?",
        (error[:500], event_id),
    )


def translate_events(
    conn: sqlite3.Connection, cfg: dict, glossary: dict,
    run: Callable[[str, dict], object], now: str | None = None,
) -> dict:
    """Translate pending calendar events in batches. Returns counts."""
    stamp = now or utcnow()
    batch_size = cfg["batch_size"]
    ceiling = cfg["max_batches_per_run"]
    rows = pending_events(conn, cfg["window_days"], batch_size * ceiling, now)

    translated = failed = batches = 0
    for start in range(0, len(rows), batch_size):
        chunk = rows[start:start + batch_size]
        ok, bad = _batch_with_fallback(
            conn, chunk, EVENT_FIELDS, glossary, run, stamp,
            _write_event, _record_event_failure,
        )
        translated += ok
        failed += bad
        batches += 1
    return {"translated": translated, "failed": failed, "batches": batches}


DEFAULT_TRANSLATOR = "codex"


def _translate_text(text: str, glossary: dict, run) -> str:
    """One model call for one document or section."""
    prompt = translatetext.build_doc_prompt(text, glossary)
    return translatetext.parse_doc_response(
        run(prompt, translatetext.doc_schema())
    )


def translate_stance(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, translator: str = DEFAULT_TRANSLATOR,
    force: bool = False,
) -> dict:
    """Translate stance.md section by section into its sidecar.

    Per-section hashing because a brief run usually rewrites one section and
    leaves five alone; hashing the whole file would pay for all six every day.

    A section that fails keeps whatever Persian it already had, and the sidecar
    is rewritten only when something actually changed — so a total failure
    leaves the previous file byte-identical rather than half-updated.
    """
    if not source.exists():
        return {"translated": 0, "failed": 0}

    existing = {}
    if sidecar.exists():
        existing = {
            heading: (section_hash, body)
            for heading, section_hash, body
            in translatetext.parse_stance_sidecar(
                sidecar.read_text(encoding="utf-8"))
        }

    translated = failed = 0
    out: list[tuple[str, str, str]] = []
    for heading, body in translatetext.split_sections(
        source.read_text(encoding="utf-8")
    ):
        digest = translatetext.src_hash(body)
        previous = existing.get(heading)
        if not force and previous and previous[0] == digest:
            out.append((heading, digest, previous[1]))
            continue
        if not body.strip():
            out.append((heading, digest, body))
            continue
        try:
            out.append((heading, digest, _translate_text(body, glossary, run)))
            translated += 1
        except (modelrun.ModelError, translatetext.ParseError):
            # Keep the previous Persian for this section, and keep its OLD
            # hash so the next run tries again rather than believing it is done.
            out.append((
                heading,
                previous[0] if previous else "",
                previous[1] if previous else body,
            ))
            failed += 1

    if translated:
        translatetext.write_atomic(
            sidecar,
            translatetext.render_stance_sidecar(
                out, now or utcnow(), translator),
        )
    return {"translated": translated, "failed": failed}


def translate_document(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, translator: str = DEFAULT_TRANSLATOR,
    force: bool = False,
) -> dict:
    """Whole-document sidecar: playbook and reports.

    Nothing parses these structurally, so unlike stance they translate as one
    unit, headings included. A failure leaves the existing sidecar byte-
    identical: a stale Persian document is better than none, and the hash
    mismatch is what keeps the panel honest about it.
    """
    if not source.exists():
        return {"translated": 0, "failed": 0}
    text = source.read_text(encoding="utf-8")
    digest = translatetext.src_hash(text)

    if not force and sidecar.exists():
        meta, _ = translatetext.parse_front_matter(
            sidecar.read_text(encoding="utf-8"))
        if meta.get("src_hash") == digest:
            return {"translated": 0, "failed": 0}

    try:
        persian = _translate_text(text, glossary, run)
    except (modelrun.ModelError, translatetext.ParseError):
        return {"translated": 0, "failed": 1}

    translatetext.write_atomic(
        sidecar,
        translatetext.render_front_matter(digest, now or utcnow(), translator)
        + persian,
    )
    return {"translated": 1, "failed": 0}


def translate_watchlist(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, force: bool = False,
) -> dict:
    """Sidecar keyed by theme, carrying only Persian and a hash.

    The English `why` is deliberately not copied across: duplicating it would
    create a second copy that drifts the moment a brief rewrites the original.
    """
    if not source.exists():
        return {"translated": 0, "failed": 0}
    entries = (yaml.safe_load(source.read_text(encoding="utf-8")) or {}).get(
        "watchlist") or []

    existing = {}
    if sidecar.exists():
        prior = (yaml.safe_load(sidecar.read_text(encoding="utf-8")) or {}).get(
            "watchlist") or []
        existing = {e.get("theme"): e for e in prior}

    translated = failed = 0
    out = []
    for entry in entries:
        theme, why = entry.get("theme", ""), entry.get("why", "")
        digest = translatetext.src_hash(why)
        previous = existing.get(theme)
        if not force and previous and previous.get("src_hash") == digest:
            out.append(previous)
            continue
        try:
            out.append({"theme": theme,
                        "why_fa": _translate_text(why, glossary, run),
                        "src_hash": digest})
            translated += 1
        except (modelrun.ModelError, translatetext.ParseError):
            if previous:
                out.append(previous)
            failed += 1

    if translated:
        translatetext.write_atomic(
            sidecar,
            yaml.safe_dump({"watchlist": out}, allow_unicode=True,
                           sort_keys=False),
        )
    return {"translated": translated, "failed": failed}


def translate_predictions(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, force: bool = False,
) -> dict:
    """Sidecar keyed by prediction id, one JSON object per line.

    A sidecar rather than a `claim_fa` field in the source because
    `jamasp predictions add` appends to that file; rewriting it here would race
    an append and could lose a prediction.
    """
    if not source.exists():
        return {"translated": 0, "failed": 0}

    existing = {}
    if sidecar.exists():
        for line in sidecar.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                existing[row.get("id")] = row

    translated = failed = 0
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
        try:
            out.append({"id": pid,
                        "claim_fa": _translate_text(claim, glossary, run),
                        "src_hash": digest})
            translated += 1
        except (modelrun.ModelError, translatetext.ParseError):
            if previous:
                out.append(previous)
            failed += 1

    if translated:
        translatetext.write_atomic(
            sidecar,
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in out),
        )
    return {"translated": translated, "failed": failed}


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
) -> dict:
    """Every document sidecar, in one pass. Returns summed counts.

    `root` rather than hard-coded paths so a test can build a whole state tree
    in tmp_path — and so a second checkout is never at risk of writing into the
    live one.
    """
    state, reports = root / "state", root / "reports"
    totals = {"translated": 0, "failed": 0}

    def merge(result):
        totals["translated"] += result["translated"]
        totals["failed"] += result["failed"]

    merge(translate_stance(state / "stance.md", state / "stance.fa.md",
                           glossary, run, now, force=force))
    merge(translate_document(state / "playbook.md", state / "playbook.fa.md",
                             glossary, run, now, force=force))
    merge(translate_watchlist(state / "watchlist.yaml",
                              state / "watchlist.fa.yaml",
                              glossary, run, now, force=force))
    merge(translate_predictions(state / "predictions.jsonl",
                                state / "predictions.fa.jsonl",
                                glossary, run, now, force=force))
    for report in new_reports(reports, cfg["reports_since"]):
        merge(translate_document(
            report, report.with_name(report.name[:-3] + ".fa.md"),
            glossary, run, now, force=force))
    return totals
