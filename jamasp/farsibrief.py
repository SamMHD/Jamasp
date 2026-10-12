"""On-demand independent Farsi brief, written by codex for the desk chat.

Independent by construction: the bundle is built from raw news, prices and
the calendar only. Jamasp's stance, reports, predictions and the flash
pass's judgements (direction, conviction, theme, Persian summaries) never
reach the prompt — the desk asked for a second opinion, not an echo.
"""
from __future__ import annotations

import contextlib
import fcntl
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jamasp import calendarview, modelrun, notify, pricesummary
from jamasp.config import load_glossary
from jamasp.db import utcnow

NEWS_WINDOW_HOURS = 24
NEWS_TIER_MIN = 2
NEWS_CAP = 150
LEDE_CHARS = 400
NO_NEWS = "(no scored gold news in the last 24 hours)"
DUBAI = timezone(timedelta(hours=4))

SCHEMA = {
    "type": "object",
    "properties": {"brief": {"type": "string"}},
    "required": ["brief"],
    "additionalProperties": False,
}


def lock_path(conn: sqlite3.Connection) -> str:
    """`<db file>.farsibrief.lock`, derived like flash.lock_path so every
    database (live, or a test's tmp one) has its own. Always empty, so the
    agent runs' `git add state/` never sees it change."""
    row = conn.execute("PRAGMA database_list").fetchone()
    dbfile = (row["file"] if row else "") or ""
    return f"{dbfile}.farsibrief.lock" if dbfile else ""


@contextlib.contextmanager
def run_lock(conn: sqlite3.Connection):
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


def lock_is_held(conn: sqlite3.Connection) -> bool:
    with run_lock(conn) as got:
        return not got


def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _news(conn: sqlite3.Connection, names: dict[str, str], now: str) -> str:
    since = (_parse(now) - timedelta(hours=NEWS_WINDOW_HOURS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    rows = conn.execute(
        "SELECT i.published_at, i.source, i.headline, i.lede FROM items i"
        " JOIN item_scores s ON s.item_id = i.id"
        " WHERE i.published_at >= ? AND i.published_at <= ? AND s.tier >= ?"
        " ORDER BY i.published_at DESC LIMIT ?",
        (since, now, NEWS_TIER_MIN, NEWS_CAP),
    ).fetchall()
    if not rows:
        return NO_NEWS
    lines = []
    for r in rows:
        lede = (r["lede"] or "").strip().replace("\n", " ")[:LEDE_CHARS]
        source = names.get(r["source"], r["source"])
        line = f"- {r['published_at'][:16].replace('T', ' ')}Z [{source}] {r['headline']}"
        lines.append(f"{line} — {lede}" if lede else line)
    return "\n".join(lines)


def build_bundle(conn: sqlite3.Connection, names: dict[str, str],
                 now: str | None = None) -> str:
    now = now or utcnow()
    return (
        f"## News (last {NEWS_WINDOW_HOURS}h, newest first)\n"
        f"{_news(conn, names, now)}\n\n"
        f"## Prices (latest, with 24h/7d change)\n"
        f"{pricesummary.render(conn, now=now)}\n\n"
        f"## Calendar (next 7 days, JSONL)\n"
        f"{calendarview.render(conn, days=7, now=now) or '(none)'}\n"
    )


def build_prompt(style: str, glossary: dict[str, str], bundle: str, now: str) -> str:
    dt = _parse(now)
    clock = f"{dt:%Y-%m-%d %H:%M} UTC ({dt.astimezone(DUBAI):%H:%M} Dubai)"
    terms = "\n".join(f"{en}: {fa}" for en, fa in glossary.items()) or "(none)"
    return (
        f"{style.strip()}\n\n"
        f"# Current time\n{clock}\n\n"
        f"# Pinned Persian terms (use exactly)\n{terms}\n\n"
        f"# Data (your only source; do not invent anything beyond it)\n{bundle}"
    )


MSG_PREPARING = "در حال آماده‌سازی بریف… (چند دقیقه)"
MSG_BUSY = "یک بریف در حال آماده‌سازی است؛ چند دقیقه دیگر می‌رسد."
MSG_QUOTA = "سهمیهٔ codex فعلاً تمام شده؛ بعداً دوباره /brief بفرستید."
MSG_FAILED = "ساخت بریف ناموفق بود؛ دوباره امتحان کنید."
PROMPT_FILE = "farsi_brief_prompt.md"


class FarsiBriefFailed(RuntimeError):
    """The brief could not be produced or delivered; the chat has been told."""


def _clean(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
    if text.rstrip().endswith("```"):
        text = text.rstrip()[:-3]
    return text.strip().strip("`").strip()


def _log(conn, text: str, ok: bool) -> None:
    # Best effort: the DB is shared with the ingest/translate writers, and a
    # "database is locked" here must not turn a delivered brief into a
    # reported failure (or a failed one into a crash before the chat hears).
    with contextlib.suppress(Exception):
        notify.log_sent(conn, text, ok=ok)


def _send(conn, token, chat_id, text, post, reply_to) -> None:
    try:
        notify.send_telegram(text, token, chat_id, post=post, reply_to=reply_to)
    except Exception:
        _log(conn, text, ok=False)
        raise
    _log(conn, text, ok=True)


def generate(conn, settings: dict, config_dir: Path, names: dict[str, str],
             reply_to: int | None = None, dry_run: bool = False,
             run=modelrun.run_json, post=None, now: str | None = None) -> str:
    with run_lock(conn) as got:
        if not got:
            return "busy"
        token = chat_id = None
        if not dry_run:
            token, chat_id = notify.resolve_chat(settings, "desk")

        def fail(message: str, why: str):
            if not dry_run:
                with contextlib.suppress(Exception):
                    _send(conn, token, chat_id, message, post, reply_to)
            raise FarsiBriefFailed(why)

        try:
            brief = _write(conn, settings, config_dir, names, run, now)
        except FarsiBriefFailed:
            raise
        except modelrun.QuotaExhausted as exc:
            fail(MSG_QUOTA, f"codex quota: {exc}")
        except Exception as exc:
            # codex failures and anything else (a locked DB, a missing prompt
            # file): the desk was told "preparing", so it must hear back.
            fail(MSG_FAILED, f"{type(exc).__name__}: {exc}")
        if not brief:
            fail(MSG_FAILED, "codex returned an empty brief")
        if dry_run:
            return brief
        parts = notify.split_message(brief)
        try:
            for n, part in enumerate(parts):
                _send(conn, token, chat_id, part, post, reply_to if n == 0 else None)
        except Exception as exc:
            raise FarsiBriefFailed(f"telegram send failed: {exc}") from exc
        return f"sent {len(parts)} part(s)"


def _write(conn, settings: dict, config_dir: Path, names: dict[str, str],
           run, now: str | None) -> str:
    """Bundle → prompt → codex → cleaned brief text (possibly empty)."""
    now = now or utcnow()
    cfg = settings.get("farsi_brief", {})
    cmd = cfg.get("cmd") or settings["translate"]["cmd"]
    style = (Path(config_dir) / PROMPT_FILE).read_text(encoding="utf-8")
    try:
        glossary = load_glossary(Path(config_dir) / "glossary.fa.yaml")
    except OSError:
        glossary = {}
    prompt = build_prompt(style, glossary, build_bundle(conn, names, now), now)
    answer = run(cmd, "codex", prompt, SCHEMA, int(cfg.get("timeout_seconds", 600)))
    return _clean(str(answer.get("brief", "")))
