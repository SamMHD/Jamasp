"""Desk Telegram listener: long-polls getUpdates and serves `/brief`.

Polling, not a webhook: the panel's host sits behind Cloudflare Access, and
polling needs no inbound exposure at all. The two are mutually exclusive per
bot, so this commits the bot to polling.

The listener decides WHETHER to run; `jamasp farsi-brief` decides WHAT to
say. It returns to polling at once after spawning, so a slow codex run never
delays the next update.
"""
from __future__ import annotations

import logging
import time

import httpx

from jamasp import db, farsibrief

log = logging.getLogger("jamasp.bot")
OFFSET_KEY = "bot_update_offset"
POLL_TIMEOUT = 50
BACKOFF_MAX = 60


class TelegramError(RuntimeError):
    pass


class TelegramAPI:
    def __init__(self, token: str, post=None):
        self._base = f"https://api.telegram.org/bot{token}"
        self._post = post

    def call(self, method: str, params: dict, timeout: float = 30):
        if self._post:
            body = self._post(f"{self._base}/{method}", params)
        else:
            body = httpx.post(f"{self._base}/{method}", json=params,
                              timeout=timeout).json()
        if not body.get("ok"):
            raise TelegramError(f"{method}: {body.get('description', body)}")
        return body["result"]


def parse_command(text: str | None, username: str) -> str | None:
    tokens = (text or "").split(maxsplit=1)
    if not tokens:
        return None
    name, _, target = tokens[0].partition("@")
    if name != "/brief":
        return None
    if target and target.lower() != username.lower():
        return None
    return "brief"


def _reply(api, chat_id, text: str, reply_to: int) -> None:
    api.call("sendMessage", {"chat_id": chat_id, "text": text,
                             "reply_to_message_id": reply_to,
                             "allow_sending_without_reply": True})


def handle_update(update: dict, conn, api, desk_chat_id: str, username: str,
                  spawn) -> None:
    message = update.get("message")
    if not message or str(message.get("chat", {}).get("id")) != str(desk_chat_id):
        return
    if parse_command(message.get("text"), username) != "brief":
        return
    mid = message["message_id"]
    if farsibrief.lock_is_held(conn):
        _reply(api, desk_chat_id, farsibrief.MSG_BUSY, mid)
        return
    _reply(api, desk_chat_id, farsibrief.MSG_PREPARING, mid)
    spawn(mid)


def initial_offset(conn, api) -> int:
    stored = db.get_meta(conn, OFFSET_KEY)
    if stored is not None:
        return int(stored)
    # First start: commands sent before the listener existed are stale.
    latest = api.call("getUpdates", {"offset": -1, "timeout": 0})
    offset = latest[-1]["update_id"] + 1 if latest else 0
    db.set_meta(conn, OFFSET_KEY, str(offset))
    return offset


def poll_once(conn, api, desk_chat_id: str, username: str, spawn,
              offset: int, timeout: int = POLL_TIMEOUT) -> int:
    updates = api.call(
        "getUpdates",
        {"offset": offset, "timeout": timeout, "allowed_updates": ["message"]},
        timeout=timeout + 10,
    )
    for update in updates:
        try:
            handle_update(update, conn, api, desk_chat_id, username, spawn)
        except Exception:  # one bad update must not stall the queue
            log.exception("update %s failed", update.get("update_id"))
        offset = update["update_id"] + 1
        db.set_meta(conn, OFFSET_KEY, str(offset))
    return offset


def run_forever(conn, api, desk_chat_id: str, spawn, sleep=time.sleep,
                stop=lambda: False) -> None:
    username = api.call("getMe", {})["username"]
    offset = initial_offset(conn, api)
    log.info("listening as @%s for the desk chat, offset %s", username, offset)
    delay = 2
    while not stop():
        try:
            offset = poll_once(conn, api, desk_chat_id, username, spawn, offset)
            delay = 2
        except Exception as exc:
            log.warning("poll failed (%s); retrying in %ss", exc, delay)
            sleep(delay)
            delay = min(delay * 2, BACKOFF_MAX)
