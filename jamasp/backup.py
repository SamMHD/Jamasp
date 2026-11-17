"""Daily snapshot of state/jamasp.db: the safety net git used to be.

Every agent run used to commit the database. By November 2026 that had left
~900 copies of it in `.git` (9 GB), and the post-commit `git gc --auto`
repack OOM-killed scans and briefs on the 3.8 GB host (todo 205 on `live`).
The database left git; this keeps the newest `keep` copies on disk instead.

A snapshot is `VACUUM INTO` a temp file. That's a consistent copy taken under
a read lock of about half a second on the host, well inside the writers'
5 s busy_timeout. Then `PRAGMA quick_check` must pass before the copy is
trusted, and only then is it gzipped into place. A copy that fails the check
is never kept, so it can't push a good one out of the retention window.
"""
from __future__ import annotations

import gzip
import os
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

PREFIX = "jamasp-"
SUFFIX = ".db.gz"


class BackupError(RuntimeError):
    """A snapshot failed its integrity check and was discarded."""


def _quick_check(path: Path) -> str:
    conn = sqlite3.connect(path)
    try:
        return conn.execute("PRAGMA quick_check").fetchone()[0]
    finally:
        conn.close()


def snapshot(conn: sqlite3.Connection, dest_dir: Path, now: datetime, keep: int) -> Path:
    """Write `jamasp-<UTC stamp>.db.gz` into `dest_dir`, prune to `keep`, return it.

    Temp files start with "." so the prune glob never sees them, and any
    failure removes them before re-raising. A part-written snapshot is never
    left behind for a restore to pick up.
    """
    dest = Path(dest_dir).expanduser()
    dest.mkdir(parents=True, exist_ok=True)
    stamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = dest / f"{PREFIX}{stamp}{SUFFIX}"
    raw_tmp = dest / f".{out.name}.raw.tmp"
    gz_tmp = dest / f".{out.name}.tmp"
    try:
        conn.commit()  # VACUUM refuses to run inside an open transaction
        conn.execute("VACUUM INTO ?", (str(raw_tmp),))
        result = _quick_check(raw_tmp)
        if result != "ok":
            raise BackupError(f"snapshot failed quick_check: {result}")
        with open(raw_tmp, "rb") as src, gzip.open(gz_tmp, "wb", compresslevel=6) as dst:
            shutil.copyfileobj(src, dst)
        os.replace(gz_tmp, out)
    except BaseException:
        gz_tmp.unlink(missing_ok=True)
        raise
    finally:
        raw_tmp.unlink(missing_ok=True)
    for old in sorted(dest.glob(f"{PREFIX}*{SUFFIX}"))[:-keep]:
        old.unlink()
    return out
