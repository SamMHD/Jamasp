# Take state/jamasp.db Out of Git — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop committing `state/jamasp.db` and replace git, as the DB's safety net, with a daily on-box snapshot. Then delete the DB's history from `live`, on the host and on GitHub.

**Architecture:** A new deterministic CLI stage, `jamasp backup`, does `VACUUM INTO` on a temp file, runs `PRAGMA quick_check` on it, gzips it into `~/backups/jamasp-db/`, keeps the newest 14, and records `meta.last_backup_at`. A daily `jamasp-backup.timer` runs it, and the watchdog reports when it stops. The repo ignores `state/jamasp.db*`. On the host, `git filter-branch --index-filter` removes the path from every commit that is only on `live`. `main` and its commits are left alone, so future `git merge origin/main` into `live` keeps working.

**Tech Stack:** Python 3.14 stdlib only (`sqlite3`, `gzip`, `shutil`, `pathlib`), click, pytest, systemd, and git 2.53 on the host.

**Spec:** none. On 2026-11-04 the user skipped the design questions and approved this direction: "stop committing db (and delete history)". The decisions below are mine (Claude's) unless quoted. Background is in the incident write-up on `live`, `docs/todo/205-scan-oom-killed-four-of-eight-slots-on-3-nov-no-memory-cap-host-swapping.md`.

**Why:** every run commits the DB (62 MB, +0.67 MB/day). `.git` on the host reached 9.1 GB of loose snapshots, and since 2026-11-03 the post-commit `git gc --auto` OOM-kills scans and briefs on a 3.8 GB box. GitHub also rejects files over 100 MiB, which the DB reaches around January 2027. The stopgap `gc.auto=0` / `maintenance.auto=false` is already set on the host and is reverted in Task 4.

## Global Constraints

- No new dependencies. Stdlib only, and no `sqlite3` CLI, which the host lacks.
- Snapshot name: `jamasp-YYYYMMDDTHHMMSSZ.db.gz` (UTC). Temp files start with `.` so the prune glob never matches them.
- Settings block in `config/settings.yaml`: `backup: {dir: "~/backups/jamasp-db", keep: 14}`. Expand `~`.
- Snapshot order: `conn.commit()`, then `VACUUM INTO` the temp file, then `PRAGMA quick_check` must return `ok`, then gzip at level 6 into a temp file, then `os.replace` it into place, then prune. Measured on the host: a 0.48 s read lock (ingest's `busy_timeout` is 5 s), and 57.8 MB gzips to 17.1 MB.
- Heartbeat: `meta.last_backup_at`, written with `db.utcnow()` after a successful snapshot.
- Watchdog: `BACKUP_STALE_HOURS = 36`. Exact strings: `DB backup has never run (meta.last_backup_at missing) — check jamasp-backup.service` and `DB backup stale: last ran {ts} (> 36h ago) — check jamasp-backup.service`.
- Timer: `OnCalendar=*-*-* 06:15:00 Asia/Dubai` (02:15 UTC, after the last scan and before the 07:30 Dubai brief), `Persistent=true`, `RandomizedDelaySec=300`. Service: `TimeoutStartSec=600`, with `OnFailure=jamasp-alert@%n.service` like every other unit.
- Ignore pattern: `state/jamasp.db*`. It covers `-journal`, `.farsibrief.lock` (tracked on `live` today) and `.passlock`.
- History rewrite touches **`live ^origin/main` only**. `main`'s five commits of the ~250 KB seed stay.
- Do not touch the n8n or receipt-reader/receipt-ocr containers (user, 2026-11-04).
- New todo ids must be ≥ 206: `live`'s agent-filed todos already reach 205, while `main` stops at 028.

## Review Focus

1. **A snapshot that fails part-way**, for example a full disk or a gzip error, must leave no partial `.gz` and no temp file, and must exit non-zero so `OnFailure` alerts. Test: `test_a_write_failure_leaves_no_partial_files` (Task 1).
2. **A backup dir holding other files**, such as the pre-cleanup snapshot from Task 4, must not be touched by the prune. Only `jamasp-*.db.gz` is pruned. Test: `test_snapshot_keeps_only_the_newest_and_ignores_other_files` (Task 1).
3. **A corrupt snapshot** must never be kept as the "good" newest copy and so push a real one out. Test: `test_failed_integrity_check_raises_and_leaves_nothing` (Task 1).
4. **A fresh host, or one where the timer was never enabled**, must be reported by the watchdog and not stay silent. Tests: `test_missing_backup_meta` and `test_stale_backup` (Task 2).
5. **An agent commit landing mid-cutover** would re-add the DB before `.gitignore` arrives. There's no unit test for this. The Task 4 runbook pauses the committing timers, writes `.git/info/exclude` first, and checks `git ls-files state/ | grep jamasp.db` is empty before resuming.

---

### Task 1: `jamasp backup`

**Files:**
- Create: `jamasp/backup.py`
- Modify: `jamasp/cli.py` (new command, next to `inbox`), `config/settings.yaml` (append the `backup:` block)
- Test: `tests/test_backup.py`, `tests/test_cli.py`

**Interfaces:**
- Produces: `class BackupError(RuntimeError)`. Also `snapshot(conn: sqlite3.Connection, dest_dir: Path, now: datetime, keep: int) -> Path`, which returns the new `.gz` path, and `_quick_check(path: Path) -> str`, which returns the first `PRAGMA quick_check` row and is a seam for tests. CLI `jamasp backup [--dest DIR] [--db] [--config-dir]` prints `backup: <path>` and sets `meta.last_backup_at`.

- [ ] **Step 1: Write the failing tests** in `tests/test_backup.py`:

```python
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
    dest = tmp_path / "bk"; dest.mkdir()
    for d in ("20261029", "20261030", "20261031", "20261101", "20261102"):
        (dest / f"jamasp-{d}T021500Z.db.gz").write_bytes(b"old")
    (dest / "pre-history-cleanup-20261104.db.gz").write_bytes(b"keep me")
    backup.snapshot(_db(tmp_path), dest, now=NOW, keep=3)
    assert sorted(p.name for p in dest.iterdir()) == [
        "jamasp-20261101T021500Z.db.gz", "jamasp-20261102T021500Z.db.gz",
        "jamasp-20261104T021500Z.db.gz", "pre-history-cleanup-20261104.db.gz"]

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
    def boom(*a, **k): raise OSError("No space left on device")
    monkeypatch.setattr(backup.shutil, "copyfileobj", boom)
    dest = tmp_path / "bk"
    with pytest.raises(OSError):
        backup.snapshot(_db(tmp_path), dest, now=NOW, keep=14)
    assert list(dest.iterdir()) == []
```

Then add to `tests/test_cli.py`:

```python
def test_backup_writes_snapshot_and_heartbeat(tmp_path):
    dbp = tmp_path / "j.db"; db.connect(dbp).close()
    result = CliRunner().invoke(main, ["backup", "--db", str(dbp), "--dest", str(tmp_path / "bk")])
    assert result.exit_code == 0, result.output
    assert result.output.startswith("backup: ")
    assert len(list((tmp_path / "bk").glob("jamasp-*.db.gz"))) == 1
    assert db.get_meta(db.connect(dbp), "last_backup_at") is not None
```

- [ ] **Step 2: Run them to verify they fail.** Run `uv run pytest tests/test_backup.py tests/test_cli.py::test_backup_writes_snapshot_and_heartbeat -q`. Expected: FAIL with `ImportError` / `No such command 'backup'`.

- [ ] **Step 3: Implement `jamasp/backup.py`** following the Global Constraints order. Wrap everything after the `mkdir` in `try/except BaseException`, unlinking both temp files before re-raising. Prune by sorting `dest.glob("jamasp-*.db.gz")` by name and unlinking all but the last `keep`. Add a module docstring giving the why (git outgrew the DB, see todo 205) in the codebase's usual voice.

- [ ] **Step 4: Implement the CLI command.** Read `settings["backup"]` for `dir`/`keep`, let `--dest` override `dir`, call `snapshot(conn, dest, datetime.now(timezone.utc), keep)`, then `set_meta(conn, "last_backup_at", utcnow())`. Append the `backup:` block to `config/settings.yaml` with a two-line comment.

- [ ] **Step 5: Run the tests to verify they pass.** Run `uv run pytest tests/test_backup.py tests/test_cli.py -q`. Expected: all pass.

- [ ] **Step 6: Commit.** `git add jamasp/backup.py jamasp/cli.py config/settings.yaml tests/test_backup.py tests/test_cli.py && git commit -m "feat: jamasp backup — daily gzipped VACUUM INTO snapshot of the DB"`

### Task 2: The watchdog notices a backup that stopped

**Files:**
- Modify: `jamasp/watchdog.py` (constants block, and `check()` right after the ingest heartbeat)
- Test: `tests/test_watchdog.py`

**Interfaces:**
- Consumes: `meta.last_backup_at` (Task 1).

- [ ] **Step 1: Write the failing tests.** Add `db.set_meta(conn, "last_backup_at", "2026-08-01T02:15:00Z")` to `healthy()`. With it, `test_healthy_no_violations` keeps passing once the check exists. Then add:

```python
def test_missing_backup_meta(tmp_path):
    conn, reports, creds = healthy(tmp_path)
    conn.execute("DELETE FROM meta WHERE key='last_backup_at'"); conn.commit()
    assert any(v.startswith("DB backup has never run") for v in _check(conn, reports, creds))

def test_stale_backup(tmp_path):
    conn, reports, creds = healthy(tmp_path)
    db.set_meta(conn, "last_backup_at", "2026-07-30T17:59:00Z")  # 36h01m before NOW
    assert any(v.startswith("DB backup stale: last ran 2026-07-30T17:59:00Z") for v in _check(conn, reports, creds))

def test_backup_inside_the_window_is_silent(tmp_path):
    conn, reports, creds = healthy(tmp_path)
    db.set_meta(conn, "last_backup_at", "2026-07-30T19:00:00Z")  # 35h before NOW
    assert not any("DB backup" in v for v in _check(conn, reports, creds))
```

- [ ] **Step 2: Run them to verify the new tests fail.** Run `uv run pytest tests/test_watchdog.py -q`. Expected: the 2 violation tests FAIL and the rest pass.

- [ ] **Step 3: Implement.** Add `BACKUP_STALE_HOURS = 36` and `_BACKUP = "check jamasp-backup.service"` with a one-line why comment (a timer that was never enabled fails silently, and `OnFailure` can't see that). Append the two exact strings from Global Constraints.

- [ ] **Step 4: Run the full suite to verify.** Run `uv run pytest -q`. Expected: all pass.

- [ ] **Step 5: Commit.** `git add jamasp/watchdog.py tests/test_watchdog.py && git commit -m "feat(watchdog): flag a DB backup that never ran or went stale"`

### Task 3: The repo stops tracking the DB

**Files:**
- Remove from index: `state/jamasp.db`, using `git rm --cached` (the file stays on disk)
- Create: `ops/systemd/jamasp-backup.service`, `ops/systemd/jamasp-backup.timer`, `docs/todo/206-db-backups-are-on-box-only.md`
- Modify: `.gitignore` (append at the end, which keeps the merge with `live`'s `*.passlock` line clean), `CLAUDE.md` (rule 4 at line 20, a toolbox row after line 40, the timer sentence at line 57), `.claude/skills/deploy/SKILL.md` (lines 100–101, 139, 280–282, 936–939), `jamasp/ingest/bars.py:290-293` (docstring clause), `docs/todo/024-…md` (a dated note: the tracked-seed half is gone, the parallel race remains)

- [ ] **Step 1: Untrack and ignore.** Run `git rm --cached state/jamasp.db`, then append to `.gitignore`:

```gitignore
# The live database is not versioned: its committed snapshots grew .git to
# 9 GB and the repack OOM-killed agent runs (Nov 2026, todo 205 on live).
# jamasp-backup.timer keeps daily snapshots instead. Covers -journal and locks.
state/jamasp.db*
```

- [ ] **Step 2: Units.** Model `jamasp-backup.service` on `jamasp-weights.service`: `Type=oneshot`, `TimeoutStartSec=600`, `WorkingDirectory=%h/Jamasp`, the same `PATH`/`EnvironmentFile`, the "deterministic pipeline stage, not an agent run" comment, and `ExecStart=%h/.local/bin/uv run jamasp backup`. Model `jamasp-backup.timer` on `jamasp-weights.timer`, using the Global Constraints schedule.

- [ ] **Step 3: Docs.**
  - CLAUDE.md rule 4 becomes: commit reports and state files with message `jamasp: <run-type> <date>`; `state/jamasp.db` is **not** committed, because it is gitignored and snapshotted daily by `jamasp backup`.
  - CLAUDE.md toolbox row: `uv run jamasp backup` | snapshot `state/jamasp.db` to `~/backups/jamasp-db` (own timer, daily).
  - CLAUDE.md: "nine systemd timers" becomes "ten", and the list gains "a daily DB backup".
  - Deploy skill: the unit count/list goes to 20 files / 10 + 10 including `backup`. Add `jamasp-backup.timer` to the line-139 enable list. Replace the line 280–282 sentence with how the box pushes now: the `jamasp-brief.service.d/push.conf` drop-in, and that it pushes reports/state but not the DB. Lines 936–939 drop the ` M state/jamasp.db` expectation. Add a short **Backups** paragraph: where snapshots live, restore = stop timers, then `gunzip -c <snap> > state/jamasp.db`, then start timers; and that the copies are on-box only (todo 206).
  - `bars.py`: replace "`state/jamasp.db` is git-tracked and committed at the end of every run … every day forever" with the reason that still holds: an unchanged row must not rewrite pages.
  - Todo 206, following `docs/todo/README.md`'s template: snapshots share the host's disk; options are Hetzner's server Backups toggle (console, no code) or R2/Storage Box via a sync step; status open.

- [ ] **Step 4: Verify.** `git check-ignore -v state/jamasp.db` prints the new `.gitignore` rule. `git ls-files state/ | grep -c jamasp.db` prints `0`. `uv run pytest -q` passes in full. `cd panel && npx vitest run` passes too, because the fixture builder recreates the now-ignored file.

- [ ] **Step 5: Commit, PR, merge.** `git add -A .gitignore CLAUDE.md .claude/skills/deploy/SKILL.md jamasp/ingest/bars.py docs/ ops/systemd/ && git commit -m "chore: stop versioning state/jamasp.db; daily backup timer replaces it"`. Push the branch, open the PR, and merge it once the review is green.

### Task 4: Host cutover (operator runbook; run by the controller, not a subagent)

> **Merge the PR only in the same session as this cutover, right before step 0.**
> Once `main` drops the DB, a routine `git merge origin/main` into `live` run
> outside this runbook stops on a modify/delete conflict on `state/jamasp.db`.
> Resolving that conflict "theirs" deletes the production database.

All commands run as `jamasp` via `su - jamasp -c` in `/home/jamasp/Jamasp`, except `systemctl` and `systemd-run`, which run as root. `<date>` is the cutover date (`YYYYMMDD`). **Before and after every git step, `stat -c %s state/jamasp.db` must show the file present and no smaller. If it is missing, stop and restore from step 2.**

- [ ] **0. Dry-run the merge (no side effects).** Run `git fetch origin && git merge-tree --write-tree --name-only live origin/main`. Expected: exactly one `CONFLICT (modify/delete)`, on `state/jamasp.db` (step 3 resolves it). Any other `CONFLICT` means stop and resolve it on a branch before pausing anything.
- [ ] **1. Pause the committing timers.** As root: `systemctl stop jamasp-scan.timer jamasp-brief.timer jamasp-retro.timer jamasp-dispatch.timer jamasp-translate.timer`. Then wait until `systemctl is-active jamasp-{scan,brief,retro,dispatch,translate}.service` all say `inactive`: stopping a timer does not stop a run already in progress. Ingest keeps running, since it never touches git.
- [ ] **2. Safety copies.** Run `mkdir -p ~/backups/jamasp-db && python3 -c "import sqlite3; sqlite3.connect('file:state/jamasp.db?mode=ro', uri=True).execute('VACUUM INTO ?', ('/home/jamasp/backups/jamasp-db/pre-history-cleanup-<date>.db',))" && gzip ~/backups/jamasp-db/pre-history-cleanup-<date>.db`. Make a hardlink copy of the object store with `cp -al .git ~/jamasp-git-pre-cleanup-<date>`, and record `OLD_ORIGIN_LIVE=$(git rev-parse origin/live)`.
- [ ] **2b. Get one copy off the box.** Steps 6–7 destroy GitHub's copies, and todo 207 has no off-box destination yet. From the operator's machine, run `scp jamasp:/home/jamasp/backups/jamasp-db/pre-history-cleanup-<date>.db.gz ~/Backups/jamasp/ && gunzip -t ~/Backups/jamasp/pre-history-cleanup-<date>.db.gz`. Expected: exit 0.
- [ ] **3. Untrack on `live`, behind a hard gate.** Run `printf 'state/jamasp.db*\n' >> .git/info/exclude`, then `git rm --cached --ignore-unmatch -q state/jamasp.db state/jamasp.db.farsibrief.lock`. Then **gate:** `test -z "$(git ls-files 'state/jamasp.db*')" || { echo STOP; exit 1; }`. This gate is not optional. `--ignore-unmatch` matters because without it, one untracked name makes the whole `git rm` fail. The DB then stays tracked, the next `git add -A` commits it, and step 4's final `read-tree -u` deletes the working file (reproduced in the final review). Then `git add -A reports/ state/ && git commit -m "jamasp: maintenance <date> stop tracking jamasp.db"`, and re-run the gate.
- [ ] **4. Rewrite `live`-only history.** `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --index-filter 'git rm --cached --ignore-unmatch -q state/jamasp.db state/jamasp.db.farsibrief.lock' -- live ^origin/main`. Expected: `git rev-list --objects live ^origin/main | grep -c 'jamasp\.db'` prints `0`, and `git diff refs/original/refs/heads/live live` is empty. A path-limited `git rev-list live ^origin/main -- state/jamasp.db` prints `1`. That is the first `live`-only commit deleting `main`'s seed, which is correct and not a failure.
- [ ] **5. Merge `main`.** `git merge --no-edit origin/main`. Expected: clean, and `git check-ignore -v state/jamasp.db` cites `.gitignore`.
- [ ] **6. Force-push.** `git push --force-with-lease=live:$OLD_ORIGIN_LIVE origin live`.
- [ ] **7. Drop the old objects.** First check that nothing else still reaches the old history. Run `git for-each-ref --format='%(refname)' | while read r; do echo "$(git rev-list --count "$r" -- state/jamasp.db) $r"; done | sort -rn | head`, `git stash list` and `git worktree list`. Only `refs/original/refs/heads/live` may count in the hundreds. Counts of 5 or fewer are `main`'s seed and are fine. Delete or rewrite anything else that is large. Then run `git update-ref -d refs/original/refs/heads/live` and `git reflog expire --expire=now --all`, and, as root, `systemd-run --wait --pipe --uid=jamasp --gid=jamasp -p MemoryMax=1200M -p WorkingDirectory=/home/jamasp/Jamasp --setenv=HOME=/home/jamasp /usr/bin/git -c pack.threads=1 -c pack.windowMemory=128m gc --prune=now`. Expected: `du -sh .git` falls from 9+ GB to well under 1 GB.
- [ ] **8. Undo the stopgap, but only if step 7 shrank `.git`.** Gate: `test "$(du -sm .git | cut -f1)" -lt 1024`. If it passes, run `git config --unset gc.auto; git config --unset maintenance.auto` as two commands, so one missing key doesn't skip the other. If the gate fails, leave the stopgap in place and investigate: re-enabling auto gc over the old store brings the OOM back.
- [ ] **9. Install and prove the backup.** Use the deploy skill's `sed` recipe for the two new units into `/etc/systemd/system/`, then `systemctl daemon-reload && systemctl enable --now jamasp-backup.timer && systemctl start jamasp-backup.service`. Expected: the journal shows `backup: /home/jamasp/backups/jamasp-db/jamasp-….db.gz`, the file is about 17 MB, and `meta.last_backup_at` is set.
- [ ] **10. Resume and verify.** As root, `systemctl start` the five timers from step 1. Timers marked `Persistent=true` that missed a slot during the pause fire immediately, so read `systemctl list-timers 'jamasp*'` and expect that. Expected: `git status --short` shows nothing about `jamasp.db`, `watchdog.check()` against a read-only DB returns `[]`, and the panel returns HTTP 200. Close `live`'s todo 205 (status `resolved`, with a resolution naming the PR) and commit `jamasp: maintenance <date> close todo 205`.
- [ ] **11. Hand-off.** Tell the user `~/jamasp-git-pre-cleanup-<date>` (about 9 GB) can be deleted after a week of clean runs.
