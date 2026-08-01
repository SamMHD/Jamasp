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


def send_telegram(text: str, token: str, chat_id: str, post: Poster | None = None) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    result = (post or _default_post)(url, {"chat_id": chat_id, "text": text})
    if not result.get("ok"):
        raise RuntimeError(f"telegram send failed: {result.get('description', result)}")


def notify(
    text: str, settings: dict, dry_run: bool = False, post: Poster | None = None
) -> str:
    cfg = settings["telegram"]
    token = os.environ.get(cfg["bot_token_env"])
    chat_id = os.environ.get(cfg["chat_id_env"])
    if not token:
        raise RuntimeError(f"missing env var {cfg['bot_token_env']}")
    if not chat_id:
        raise RuntimeError(f"missing env var {cfg['chat_id_env']}")
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
