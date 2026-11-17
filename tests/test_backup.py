import gzip
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pytest

from jamasp import backup, db

NOW = datetime(2026, 11, 4, 2, 15, 0, tzinfo=timezone.utc)


def _db(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    db.set_meta(conn, "probe", "x")
    return conn


def test_snapshot_is_a_gzipped_db_that_opens(tmp_path):
    out = backup.snapshot(_db(tmp_path), tmp_path / "bk", now=NOW, keep=14)
    assert out.name == "jamasp-20261104T021500Z.db.gz"
    restored = tmp_path / "restored.db"
    restored.write_bytes(gzip.decompress(out.read_bytes()))
    r = sqlite3.connect(restored)
    assert r.execute("SELECT value FROM meta WHERE key='probe'").fetchone()[0] == "x"


def test_snapshot_keeps_only_the_newest_and_ignores_other_files(tmp_path):
    dest = tmp_path / "bk"
    dest.mkdir()
    for d in ("20261029", "20261030", "20261031", "20261101", "20261102"):
        (dest / f"jamasp-{d}T021500Z.db.gz").write_bytes(b"old")
    (dest / "pre-history-cleanup-20261104.db.gz").write_bytes(b"keep me")
    backup.snapshot(_db(tmp_path), dest, now=NOW, keep=3)
    assert sorted(p.name for p in dest.iterdir()) == [
        "jamasp-20261101T021500Z.db.gz",
        "jamasp-20261102T021500Z.db.gz",
        "jamasp-20261104T021500Z.db.gz",
        "pre-history-cleanup-20261104.db.gz",
    ]


def test_snapshot_expands_home_and_creates_the_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    out = backup.snapshot(_db(tmp_path), Path("~/backups/jamasp-db"), now=NOW, keep=14)
    assert out.parent == tmp_path / "backups" / "jamasp-db"


def test_failed_integrity_check_raises_and_leaves_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(backup, "_quick_check", lambda path: "row 3 missing from index")
    dest = tmp_path / "bk"
    with pytest.raises(backup.BackupError, match="row 3 missing"):
        backup.snapshot(_db(tmp_path), dest, now=NOW, keep=14)
    assert list(dest.iterdir()) == []


def test_a_write_failure_leaves_no_partial_files(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise OSError("No space left on device")

    monkeypatch.setattr(backup.shutil, "copyfileobj", boom)
    dest = tmp_path / "bk"
    with pytest.raises(OSError):
        backup.snapshot(_db(tmp_path), dest, now=NOW, keep=14)
    assert list(dest.iterdir()) == []
