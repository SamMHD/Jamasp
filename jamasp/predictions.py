"""Structured, scoreable forecasts in state/predictions.jsonl."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jamasp.db import utcnow
from jamasp.ingest import prices

DIRECTIONS = {"up", "down", "flat"}
OUTCOMES = {"hit", "miss", "unclear"}
DUBAI = timezone(timedelta(hours=4))


def load(path: Path) -> list[dict]:
    if not Path(path).exists():
        return []
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]


def _dump(path: Path, entries: list[dict]) -> None:
    Path(path).write_text(
        "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries)
    )


def add(
    path: Path,
    claim: str,
    direction: str,
    horizon_days: int,
    confidence: float,
    now: str | None = None,
) -> dict:
    if direction not in DIRECTIONS:
        raise ValueError(f"direction must be one of {sorted(DIRECTIONS)}")
    if not 0.0 <= confidence <= 1.0:
        raise ValueError("confidence must be in [0, 1]")
    if horizon_days < 1:
        raise ValueError("horizon_days must be >= 1")
    created_at = now or utcnow()
    dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    entry = {
        "id": hashlib.sha256(f"{created_at}|{claim}".encode()).hexdigest()[:8],
        "date": dt.astimezone(DUBAI).strftime("%Y-%m-%d"),
        "claim": claim,
        "direction": direction,
        "horizon_days": horizon_days,
        "confidence": confidence,
        "created_at": created_at,
        "outcome": None,
        "scored_at": None,
        "note": None,
    }
    entries = load(path)
    entries.append(entry)
    _dump(path, entries)
    return entry


def due(path: Path, now: str | None = None) -> list[dict]:
    now_dt = datetime.fromisoformat((now or utcnow()).replace("Z", "+00:00"))
    out = []
    for e in load(path):
        if e["outcome"] is not None:
            continue
        created = datetime.fromisoformat(e["created_at"].replace("Z", "+00:00"))
        if created + timedelta(days=e["horizon_days"]) <= now_dt:
            out.append(e)
    return out


def score(
    path: Path, pred_id: str, outcome: str, note: str | None = None, now: str | None = None
) -> dict:
    if outcome not in OUTCOMES:
        raise ValueError(f"outcome must be one of {sorted(OUTCOMES)}")
    entries = load(path)
    match = [e for e in entries if e["id"] == pred_id]
    if not match:
        raise KeyError(f"no prediction with id {pred_id}")
    entry = match[0]
    if entry["outcome"] is not None:
        raise ValueError(f"prediction {pred_id} already scored: {entry['outcome']}")
    entry.update(outcome=outcome, scored_at=now or utcnow(), note=note)
    _dump(path, entries)
    return entry


def open_unscored(path: Path, now: str | None = None) -> list[dict]:
    """Unscored predictions that have not yet matured."""
    now_dt = datetime.fromisoformat((now or utcnow()).replace("Z", "+00:00"))
    out = []
    for e in load(path):
        if e["outcome"] is not None:
            continue
        created = datetime.fromisoformat(e["created_at"].replace("Z", "+00:00"))
        if created + timedelta(days=e["horizon_days"]) > now_dt:
            out.append(e)
    return out


def render_due(
    conn: sqlite3.Connection,
    path: Path,
    symbol: str,
    now: str | None = None,
    include_open: bool = False,
) -> str:
    """Matured unscored predictions, annotated with the window's price action.

    `window_high`/`window_low` are what settle a level claim — an overnight
    touch that mean-reverts is invisible to price_then/price_now. With
    `include_open`, still-running claims are listed too (`matured: false`),
    so a run can read a live claim's status off the DB instead of recalling
    it from an earlier run's narrative.
    """
    now_ts = now or utcnow()
    entries = [(e, True) for e in due(path, now=now_ts)]
    if include_open:
        entries += [(e, False) for e in open_unscored(path, now=now_ts)]
    matured_n = sum(1 for _, m in entries if m)
    header = f"# jamasp predictions due — {matured_n} matured, unscored"
    if include_open:
        header += f"; {len(entries) - matured_n} still open"
    lines = [header]
    for e, matured in entries:
        then = prices.row_at_or_before(conn, symbol, e["created_at"])
        latest_row = prices.row_at_or_before(conn, symbol, now_ts)
        annotated = dict(e)
        annotated["matured"] = matured
        annotated["price_then"] = then["value"] if then else None
        annotated["price_now"] = latest_row["value"] if latest_row else None
        if then and latest_row and then["value"]:
            annotated["move_pct"] = round(
                (latest_row["value"] - then["value"]) / then["value"] * 100, 2
            )
        else:
            annotated["move_pct"] = None
        annotated.update(
            {
                f"window_{k}": v
                for k, v in prices.window_extremes(
                    conn, symbol, e["created_at"], now_ts
                ).items()
            }
        )
        lines.append(json.dumps(annotated, ensure_ascii=False))
    return "\n".join(lines)
