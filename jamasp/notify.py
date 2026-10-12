"""Telegram delivery via raw Bot API."""
from __future__ import annotations

import os
import sqlite3
from typing import Callable

import httpx

from jamasp.db import utcnow

Poster = Callable[[str, dict], dict]


def _default_post(url: str, data: dict) -> dict:
    resp = httpx.post(url, data=data, timeout=30)
    return resp.json()


class MessageGone(RuntimeError):
    """Telegram refused an edit because the target message no longer exists."""


TELEGRAM_LIMIT = 4096


def send_telegram(
    text: str, token: str, chat_id: str, post: Poster | None = None,
    reply_to: int | None = None,
) -> int:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data: dict = {"chat_id": chat_id, "text": text}
    if reply_to is not None:
        data["reply_to_message_id"] = reply_to
        # The trigger may be deleted while the reply is being prepared; send
        # anyway rather than lose minutes of work to a missing anchor.
        data["allow_sending_without_reply"] = "true"
    result = (post or _default_post)(url, data)
    if not result.get("ok"):
        raise RuntimeError(f"telegram send failed: {result.get('description', result)}")
    return int(result["result"]["message_id"])


def _pack(pieces: list[str], sep: str, limit: int) -> list[str]:
    parts: list[str] = []
    current = ""
    for piece in pieces:
        candidate = f"{current}{sep}{piece}" if current else piece
        if len(candidate) <= limit:
            current = candidate
            continue
        if current:
            parts.append(current)
        current = piece
    if current:
        parts.append(current)
    return parts


def split_message(text: str, limit: int = TELEGRAM_LIMIT) -> list[str]:
    """Split text into Telegram-sized parts: paragraphs, then lines, then a
    hard cut — the coarsest boundary that fits wins, so a reader never sees a
    sentence torn across two messages unless one line alone is over limit."""
    if len(text) <= limit:
        return [text]
    out: list[str] = []
    for para in _pack(text.split("\n\n"), "\n\n", limit):
        if len(para) <= limit:
            out.append(para)
            continue
        for line in _pack(para.split("\n"), "\n", limit):
            while len(line) > limit:
                out.append(line[:limit])
                line = line[limit:]
            if line:
                out.append(line)
    return out


def edit_telegram(
    text: str,
    token: str,
    chat_id: str,
    message_id: int,
    post: Poster | None = None,
) -> None:
    url = f"https://api.telegram.org/bot{token}/editMessageText"
    result = (post or _default_post)(
        url, {"chat_id": chat_id, "text": text, "message_id": message_id}
    )
    if result.get("ok"):
        return
    description = str(result.get("description", result))
    # the message was deleted from the channel; retrying can never succeed
    if "message to edit not found" in description.lower():
        raise MessageGone(description)
    raise RuntimeError(f"telegram edit failed: {description}")


def resolve_chat(settings: dict, chat: str = "desk") -> tuple[str, str]:
    """Return (token, chat_id) for the named chat: 'desk' or 'news'."""
    cfg = settings["telegram"]
    token = os.environ.get(cfg["bot_token_env"])
    if not token:
        raise RuntimeError(f"missing env var {cfg['bot_token_env']}")
    key = "chat_id_env" if chat == "desk" else "news_chat_id_env"
    env_name = cfg.get(key)
    if not env_name:
        raise RuntimeError(f"telegram.{key} is not configured in settings.yaml")
    chat_id = os.environ.get(env_name)
    if not chat_id:
        raise RuntimeError(f"missing env var {env_name}")
    return token, chat_id


def notify(
    text: str,
    settings: dict,
    dry_run: bool = False,
    post: Poster | None = None,
    chat: str = "desk",
) -> str:
    token, chat_id = resolve_chat(settings, chat)
    if dry_run:
        return f"[dry-run] would send {len(text)} chars to chat {chat_id}"
    send_telegram(text, token, chat_id, post=post)
    return f"sent {len(text)} chars to chat {chat_id}"


def log_sent(conn: sqlite3.Connection, text: str, ok: bool) -> None:
    """Record a Telegram message attempt so the panel's Alerts page can show it."""
    conn.execute(
        "INSERT INTO notify_log (ts, text, ok) VALUES (?, ?, ?)",
        (utcnow(), text, 1 if ok else 0),
    )
    conn.commit()
