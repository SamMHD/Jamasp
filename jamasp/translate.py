"""Fill Persian renderings of everything the panel renders.

Four passes: a free SQL copy of Persian the flash pipeline already wrote, two
batched model passes over `items` and `events`, and a sidecar pass over the
documents agent runs write. Presentation only — no analysis run ever reads
Persian, and nothing here touches Telegram.

Runs on its own timer, never wrapped by `jamasp run`, so it consumes none of
the daily agent-run cap.
"""
from __future__ import annotations

import sqlite3

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
