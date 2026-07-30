"""Batched Haiku pass: write uniform one-line ledes for new items."""
from __future__ import annotations

import json
import sqlite3
import subprocess

PROMPT_HEADER = """You are a financial newswire editor for a gold trading desk.
For each line below (format: id<TAB>headline), write a neutral one-line lede
of at most 25 words stating the concrete fact and, where obvious, its gold-market relevance.
Respond with ONLY a JSON object mapping each id to its lede string. No other text.

"""


def build_prompt(rows: list[sqlite3.Row]) -> str:
    lines = "\n".join(f"{r['id']}\t{r['headline']}" for r in rows)
    return PROMPT_HEADER + lines


def parse_response(text: str) -> dict[str, str]:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in response")
    parsed = json.loads(text[start : end + 1])
    return {k: str(v) for k, v in parsed.items()}


def run_digest(conn: sqlite3.Connection, settings: dict) -> int:
    cfg = settings["digest"]
    rows = conn.execute(
        "SELECT id, headline FROM items WHERE lede IS NULL AND read_at IS NULL"
        " ORDER BY published_at DESC LIMIT ?",
        (cfg["batch_max_items"],),
    ).fetchall()
    if not rows:
        return 0
    try:
        result = subprocess.run(
            list(cfg["claude_cmd"]) + [build_prompt(rows)],
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        )
        ledes = parse_response(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError, json.JSONDecodeError) as exc:
        conn.execute(
            "INSERT INTO source_errors (source, ts, error) VALUES ('digest', "
            "strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)",
            (str(exc)[:500],),
        )
        conn.commit()
        return 0
    updated = 0
    for item_id, lede in ledes.items():
        cur = conn.execute(
            "UPDATE items SET lede = ? WHERE id = ? AND lede IS NULL", (lede, item_id)
        )
        updated += cur.rowcount
    conn.commit()
    return updated
