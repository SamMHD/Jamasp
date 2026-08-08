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


def send_telegram(text: str, token: str, chat_id: str, post: Poster | None = None) -> int:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    result = (post or _default_post)(url, {"chat_id": chat_id, "text": text})
    if not result.get("ok"):
        raise RuntimeError(f"telegram send failed: {result.get('description', result)}")
    return int(result["result"]["message_id"])


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
