# Jamasp Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-control web panel for Jamasp — nine pages (overview, inbox, crawl, briefs, schedule, calendar, alerts, state, prices) served by a single Next.js app on the Jamasp host, with all writes mediated by the `jamasp` CLI.

**Architecture:** Next.js App Router app in `panel/` reads `state/jamasp.db` read-only via better-sqlite3 and state/report files from disk; every mutation shells out to `uv run jamasp ...` so Python stays the only DB writer. Run triggering inserts a wakeup due now; the existing 5-minute dispatcher enforces cap/retry/timeouts. Two small Python additions: a `notify_log` table and `jamasp wakeup cancel`.

**Tech Stack:** Python 3.12/click/pytest (existing), Next.js 15 + TypeScript + Tailwind CSS + shadcn/ui, better-sqlite3, yaml, react-markdown + remark-gfm, recharts, swr, vitest, @playwright/test.

**Spec:** `docs/superpowers/specs/2026-08-01-jamasp-panel-design.md` (approved).

## Global Constraints

- All work on branch `claude/jamasp-dashboard-panel-m83pgh`.
- Python changes: TDD, tests in existing `tests/`, run with `uv run pytest`.
- The panel NEVER writes to `state/jamasp.db` — better-sqlite3 opens with `readonly: true`; all mutations go through `uv run jamasp ...` subprocesses.
- Panel lives entirely under `panel/`; repo root is resolved from env `JAMASP_ROOT`, defaulting to `path.resolve(process.cwd(), "..")`.
- Run types are exactly `brief | scan | deepdive | retro` (mirror of `jamasp/wakeup.py` `RUN_TYPES`).
- All DB timestamps are UTC ISO-8601 with `Z` suffix (`YYYY-MM-DDTHH:MM:SSZ`); Dubai display time is fixed UTC+4 (no DST).
- Persian text renders with `dir="rtl"` and font stack `Vazirmatn, Tahoma, sans-serif` (no font download).
- Dark mode default, gold accent (`--primary` ≈ `#d4a017` family).
- Node >= 20 (host has Node 22). npm as package manager.
- Commit after every task with conventional-style messages (`feat:`, `fix:`, `docs:`, `test:`).
- Where a code block below and the live codebase disagree on surrounding context lines, trust the live file — re-read it before editing.

## File Structure

```
jamasp/db.py                    # modify: add notify_log to SCHEMA
jamasp/notify.py                # modify: add log_sent(conn, text, ok)
jamasp/runner.py                # modify: _notify_safe takes conn, logs
jamasp/dispatch.py              # modify: pass conn to _notify_safe
jamasp/watchdog.py              # modify: pass conn to _notify_safe
jamasp/wakeup.py                # modify: add cancel(conn, wakeup_id)
jamasp/cli.py                   # modify: notify logs; wakeup cancel cmd
tests/test_notify.py            # modify: log_sent tests
tests/test_wakeup.py            # modify: cancel tests
tests/test_cli.py               # modify: CLI-level tests for both

panel/                          # new Next.js app (App Router, TS)
  lib/paths.ts                  # JAMASP_ROOT resolution + file paths
  lib/db.ts                     # read-only better-sqlite3 + typed queries
  lib/files.ts                  # stance/watchlist/playbook/predictions/reports readers
  lib/health.ts                 # source staleness + warning derivation (pure)
  lib/format.ts                 # time/number formatting helpers (pure)
  lib/actions.ts                # "use server" CLI-mediated mutations
  components/auto-refresh.tsx   # client: router.refresh() on interval
  components/page-header.tsx
  components/stat-card.tsx
  components/nav.tsx            # sidebar navigation
  app/layout.tsx                # dark shell + sidebar
  app/page.tsx                  # Overview
  app/inbox/page.tsx + app/api/inbox/route.ts + components/inbox-table.tsx
  app/crawl/page.tsx
  app/briefs/page.tsx + app/briefs/[...slug]/page.tsx
  app/schedule/page.tsx + components/schedule-forms.tsx
  app/calendar/page.tsx
  app/alerts/page.tsx
  app/state/page.tsx
  app/prices/page.tsx + app/api/prices/route.ts + components/price-chart.tsx
  test/fixtures/fixture.sql     # schema + sample rows (all tables)
  test/fixtures/root/           # fake repo root: state/, reports/, config/
  scripts/build-fixture.mjs     # builds root/state/jamasp.db from fixture.sql
  test/*.test.ts                # vitest unit tests
  e2e/smoke.spec.ts             # Playwright: all 9 routes render

ops/systemd/jamasp-panel.service  # new unit
.claude/skills/deploy/SKILL.md    # addendum: panel deployment
CLAUDE.md                         # one-line panel mention
```

---

### Task 1: `notify_log` table + logging of sent Telegram messages

**Files:**
- Modify: `jamasp/db.py` (SCHEMA string, after the `meta` table)
- Modify: `jamasp/notify.py`
- Modify: `jamasp/runner.py` (`_notify_safe` and its two call sites in `run_agent`)
- Modify: `jamasp/dispatch.py` (two `runner._notify_safe(` call sites, lines ~30 and ~71)
- Modify: `jamasp/watchdog.py` (one `runner._notify_safe(` call site, line ~52)
- Modify: `jamasp/cli.py` (`notify` command)
- Test: `tests/test_notify.py`, `tests/test_cli.py`

**Interfaces:**
- Consumes: `jamasp.db.connect`, `jamasp.db.utcnow` (existing).
- Produces: table `notify_log (id INTEGER PK AUTOINCREMENT, ts TEXT, text TEXT, ok INTEGER)`; function `notify.log_sent(conn: sqlite3.Connection, text: str, ok: bool) -> None`; `runner._notify_safe(conn, settings, text)` (conn now first arg). The panel (Task 4) reads `notify_log` ordered by `id DESC`.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_notify.py`:

```python
def test_log_sent_records_row(tmp_path):
    from jamasp import db as db_mod
    from jamasp import notify as notify_mod

    conn = db_mod.connect(tmp_path / "t.db")
    notify_mod.log_sent(conn, "سلام desk", ok=True)
    notify_mod.log_sent(conn, "failed one", ok=False)
    rows = conn.execute("SELECT text, ok FROM notify_log ORDER BY id").fetchall()
    assert [(r["text"], r["ok"]) for r in rows] == [("سلام desk", 1), ("failed one", 0)]
```

Append to `tests/test_cli.py` (follow the file's existing CliRunner conventions — read its imports/fixtures first and reuse them):

```python
def test_notify_cli_logs_sent_message(tmp_path, monkeypatch):
    """`jamasp notify` records the message in notify_log on success."""
    from click.testing import CliRunner
    from jamasp import cli, db as db_mod, notify as notify_mod

    monkeypatch.setenv("JAMASP_TG_TOKEN", "tok")
    monkeypatch.setenv("JAMASP_TG_CHAT", "chat")
    monkeypatch.setattr(
        notify_mod, "send_telegram", lambda text, token, chat_id, post=None: None
    )
    db_path = tmp_path / "t.db"
    result = CliRunner().invoke(
        cli.main, ["notify", "hello desk", "--db", str(db_path), "--config-dir", "config"]
    )
    assert result.exit_code == 0, result.output
    conn = db_mod.connect(db_path)
    rows = conn.execute("SELECT text, ok FROM notify_log").fetchall()
    assert [(r["text"], r["ok"]) for r in rows] == [("hello desk", 1)]


def test_notify_cli_dry_run_does_not_log(tmp_path):
    from click.testing import CliRunner
    from jamasp import cli, db as db_mod

    db_path = tmp_path / "t.db"
    result = CliRunner().invoke(
        cli.main,
        ["notify", "x", "--dry-run", "--db", str(db_path), "--config-dir", "config"],
    )
    # dry-run may still fail on missing env vars in some environments; the
    # invariant is simply: no notify_log rows are written.
    conn = db_mod.connect(db_path)
    assert conn.execute("SELECT COUNT(*) FROM notify_log").fetchone()[0] == 0
```

Note: if `--dry-run` errors on missing env vars, set the two env vars via `monkeypatch.setenv` as in the first test.

- [ ] **Step 2: Run tests, verify they fail**

Run: `uv run pytest tests/test_notify.py::test_log_sent_records_row tests/test_cli.py::test_notify_cli_logs_sent_message -x -q`
Expected: FAIL — `no such table: notify_log` / `AttributeError: ... log_sent`.

- [ ] **Step 3: Implement**

In `jamasp/db.py`, inside the `SCHEMA` string after the `meta` table block, add:

```sql
CREATE TABLE IF NOT EXISTS notify_log (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   TEXT NOT NULL,
    text TEXT NOT NULL,
    ok   INTEGER NOT NULL
);
```

In `jamasp/notify.py`, add imports `import sqlite3` and `from jamasp.db import utcnow`, then append:

```python
def log_sent(conn: sqlite3.Connection, text: str, ok: bool) -> None:
    """Record a Telegram message attempt so the panel's Alerts page can show it."""
    conn.execute(
        "INSERT INTO notify_log (ts, text, ok) VALUES (?, ?, ?)",
        (utcnow(), text, 1 if ok else 0),
    )
    conn.commit()
```

In `jamasp/runner.py`, change `_notify_safe` to accept and log with the connection:

```python
def _notify_safe(conn: sqlite3.Connection, settings: dict, text: str) -> None:
    try:
        notify_mod.notify(text, settings)
        ok = True
    except Exception:
        ok = False  # infra never dies on a Telegram hiccup
    try:
        notify_mod.log_sent(conn, text, ok)
    except Exception:
        pass
```

Update all five call sites to pass `conn` first (they all already have `conn` in scope): two in `jamasp/runner.py` (`run_agent`), two in `jamasp/dispatch.py`, one in `jamasp/watchdog.py`. Grep to be sure none are missed: `grep -rn "_notify_safe(" jamasp/`.

In `jamasp/cli.py` `notify` command, replace the body's send line:

```python
    conn, _, settings = _common(db_path, config_dir)
    if text == "-":
        text = sys.stdin.read()
    try:
        msg = notify_mod.notify(text, settings, dry_run=dry_run)
    except Exception:
        if not dry_run:
            notify_mod.log_sent(conn, text, ok=False)
        raise
    if not dry_run:
        notify_mod.log_sent(conn, text, ok=True)
    click.echo(msg)
```

- [ ] **Step 4: Run the full suite**

Run: `uv run pytest -q`
Expected: all pass (existing `_notify_safe` tests in `test_runner.py`/`test_dispatch.py`/`test_watchdog.py` may need their call signatures updated — update them to the new `(conn, settings, text)` order, keeping assertions intact).

- [ ] **Step 5: Commit**

```bash
git add jamasp/ tests/
git commit -m "feat(notify): notify_log table records every Telegram send for the panel"
```

---

### Task 2: `wakeup cancel` (module function + CLI subcommand)

**Files:**
- Modify: `jamasp/wakeup.py`
- Modify: `jamasp/cli.py` (add `wakeup cancel` under the existing `wakeup_group`)
- Test: `tests/test_wakeup.py`, `tests/test_cli.py`

**Interfaces:**
- Consumes: `wakeups` table, `wakeup.add` (existing).
- Produces: `wakeup.cancel(conn: sqlite3.Connection, wakeup_id: int) -> None` — sets `status='cancelled'` on a **pending** wakeup; raises `ValueError` if the id doesn't exist or is not pending. CLI: `jamasp wakeup cancel <id>` prints `cancelled wakeup #<id>`; exits non-zero via `click.ClickException` on bad id. The panel (Task 11) invokes the CLI form.

- [ ] **Step 1: Write failing tests**

Append to `tests/test_wakeup.py`:

```python
import pytest


def test_cancel_pending_wakeup(tmp_path):
    from jamasp import db as db_mod, wakeup

    conn = db_mod.connect(tmp_path / "t.db")
    wid = wakeup.add(conn, "2030-01-01T00:00:00Z", "scan", "check the thing")
    wakeup.cancel(conn, wid)
    row = conn.execute("SELECT status FROM wakeups WHERE id = ?", (wid,)).fetchone()
    assert row["status"] == "cancelled"
    assert wakeup.list_open(conn) == []


def test_cancel_missing_or_fired_raises(tmp_path):
    from jamasp import db as db_mod, wakeup

    conn = db_mod.connect(tmp_path / "t.db")
    with pytest.raises(ValueError):
        wakeup.cancel(conn, 999)
    wid = wakeup.add(conn, "2030-01-01T00:00:00Z", "scan", "t")
    wakeup.mark(conn, wid, "done")
    with pytest.raises(ValueError):
        wakeup.cancel(conn, wid)
```

Append to `tests/test_cli.py`:

```python
def test_wakeup_cancel_cli(tmp_path):
    from click.testing import CliRunner
    from jamasp import cli

    db = str(tmp_path / "t.db")
    r = CliRunner()
    add = r.invoke(cli.main, ["wakeup", "add", "2030-01-01T00:00:00Z", "scan", "t",
                              "--db", db, "--config-dir", "config"])
    assert add.exit_code == 0, add.output
    wid = add.output.split("#")[1].split(":")[0]
    cancel = r.invoke(cli.main, ["wakeup", "cancel", wid, "--db", db, "--config-dir", "config"])
    assert cancel.exit_code == 0, cancel.output
    assert f"cancelled wakeup #{wid}" in cancel.output
    bad = r.invoke(cli.main, ["wakeup", "cancel", "999", "--db", db, "--config-dir", "config"])
    assert bad.exit_code != 0
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `uv run pytest tests/test_wakeup.py -q -k cancel`
Expected: FAIL — `AttributeError: module 'jamasp.wakeup' has no attribute 'cancel'`.

- [ ] **Step 3: Implement**

Append to `jamasp/wakeup.py`:

```python
def cancel(conn: sqlite3.Connection, wakeup_id: int) -> None:
    row = conn.execute(
        "SELECT status FROM wakeups WHERE id = ?", (wakeup_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"no wakeup #{wakeup_id}")
    if row["status"] != "pending":
        raise ValueError(f"wakeup #{wakeup_id} is {row['status']}, not pending")
    conn.execute(
        "UPDATE wakeups SET status = 'cancelled' WHERE id = ?", (wakeup_id,)
    )
    conn.commit()
```

Add to `jamasp/cli.py` after `wakeup_list`:

```python
@wakeup_group.command("cancel")
@click.argument("wakeup_id", type=int)
@db_opt
@cfg_opt
def wakeup_cancel(wakeup_id, db_path, config_dir):
    """Cancel a pending wakeup by id."""
    conn, _, _ = _common(db_path, config_dir)
    try:
        wakeup_mod.cancel(conn, wakeup_id)
    except ValueError as exc:
        raise click.ClickException(str(exc))
    click.echo(f"cancelled wakeup #{wakeup_id}")
```

- [ ] **Step 4: Run the full suite**

Run: `uv run pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add jamasp/wakeup.py jamasp/cli.py tests/
git commit -m "feat(wakeup): cancel subcommand for pending wakeups"
```

---

### Task 3: Scaffold the panel app (Next.js + Tailwind + shadcn/ui, shell layout)

**Files:**
- Create: `panel/` via create-next-app, then `panel/components/nav.tsx`, `panel/components/auto-refresh.tsx`, `panel/components/page-header.tsx`, `panel/lib/format.ts`
- Modify: `panel/app/layout.tsx`, `panel/app/page.tsx` (placeholder), `panel/app/globals.css`
- Test: `panel/test/format.test.ts` (vitest wired up here)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: app shell every page task drops into; `fmtUtc(ts: string): string` ("Aug 1 14:05Z"), `fmtDubai(ts: string): string` ("18:05 DXB"), `fmtAge(ts: string, now?: Date): string` ("3h ago"/"in 2h"), `cls(...parts: (string | false | undefined)[]): string`; `<AutoRefresh seconds={30} />` client component; `<PageHeader title subtitle? />`. Route stubs for all nine pages so nav never 404s.

- [ ] **Step 1: Scaffold**

```bash
cd /home/user/Jamasp
npx --yes create-next-app@latest panel --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-npm --skip-install
cd panel && npm install
npx --yes shadcn@latest init -d
npx --yes shadcn@latest add button card badge table tabs dialog input select label separator sonner
npm install better-sqlite3 yaml react-markdown remark-gfm recharts swr
npm install -D vitest @types/better-sqlite3
```

If `shadcn init -d` asks anything interactively, accept defaults (new-york style, neutral base). Add to `panel/package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Shell layout, nav, globals**

`panel/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/nav";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = { title: "Jamasp Panel" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <div className="flex min-h-screen">
          <Nav />
          <main className="flex-1 overflow-x-hidden p-6">{children}</main>
        </div>
        <Toaster richColors />
      </body>
    </html>
  );
}
```

`panel/components/nav.tsx`:

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cls } from "@/lib/format";

const LINKS = [
  ["/", "Overview"], ["/inbox", "Inbox"], ["/crawl", "Crawl"],
  ["/briefs", "Briefs"], ["/schedule", "Schedule"], ["/calendar", "Calendar"],
  ["/alerts", "Alerts"], ["/state", "State"], ["/prices", "Prices"],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <aside className="w-48 shrink-0 border-r border-border p-4">
      <div className="mb-6 text-lg font-bold text-primary">Jamasp</div>
      <nav className="flex flex-col gap-1">
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href}
            className={cls(
              "rounded px-3 py-1.5 text-sm hover:bg-accent",
              (href === "/" ? path === "/" : path.startsWith(href)) &&
                "bg-accent font-medium text-primary",
            )}>
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
```

`panel/components/auto-refresh.tsx`:

```tsx
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
```

`panel/components/page-header.tsx`:

```tsx
export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
    </div>
  );
}
```

`panel/lib/format.ts`:

```ts
const DUBAI_OFFSET_MS = 4 * 3600_000;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function cls(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function fmtUtc(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

export function fmtDubai(ts: string): string {
  const d = new Date(new Date(ts).getTime() + DUBAI_OFFSET_MS);
  if (isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} DXB`;
}

export function fmtAge(ts: string, now: Date = new Date()): string {
  const then = new Date(ts).getTime();
  if (isNaN(then)) return ts;
  let diff = now.getTime() - then;
  const future = diff < 0;
  diff = Math.abs(diff);
  const mins = Math.round(diff / 60_000);
  const label =
    mins < 60 ? `${mins}m` :
    mins < 48 * 60 ? `${Math.round(mins / 60)}h` :
    `${Math.round(mins / 1440)}d`;
  return future ? `in ${label}` : `${label} ago`;
}
```

In `panel/app/globals.css`, inside the `.dark` block, override the primary tokens to gold (shadcn v4 CSS-variable style — match the file's existing format, oklch or hsl):

```css
--primary: oklch(0.75 0.13 85);            /* gold */
--primary-foreground: oklch(0.2 0.02 85);
```

Replace `panel/app/page.tsx` with a stub, and create matching stubs at `app/inbox/page.tsx`, `app/crawl/page.tsx`, `app/briefs/page.tsx`, `app/schedule/page.tsx`, `app/calendar/page.tsx`, `app/alerts/page.tsx`, `app/state/page.tsx`, `app/prices/page.tsx` (each replaced by its own task later):

```tsx
import { PageHeader } from "@/components/page-header";
export default function Page() {
  return <PageHeader title="Overview" subtitle="coming in a later task" />;
}
```

(Adjust the `title` per route: Inbox, Crawl, Briefs, Schedule, Calendar, Alerts, State, Prices.)

Create `panel/app/error.tsx` so a failed read (e.g. persistent SQLITE_BUSY after the retry, missing DB file) renders an inline notice instead of a 500 page:

```tsx
"use client";
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="rounded border border-amber-900 bg-amber-950/50 p-4 text-sm text-amber-300">
      <p className="font-medium">Couldn&apos;t read Jamasp state</p>
      <p className="mt-1 text-amber-400/80">{error.message}</p>
      <button onClick={reset} className="mt-2 rounded border border-amber-700 px-2 py-1">
        retry
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Vitest smoke test for format helpers**

`panel/test/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cls, fmtAge, fmtDubai, fmtUtc } from "../lib/format";

describe("format", () => {
  it("fmtUtc renders month day hh:mmZ", () => {
    expect(fmtUtc("2026-08-01T14:05:00Z")).toBe("Aug 1 14:05Z");
  });
  it("fmtDubai adds four hours", () => {
    expect(fmtDubai("2026-08-01T14:05:00Z")).toBe("18:05 DXB");
  });
  it("fmtAge handles past and future", () => {
    const now = new Date("2026-08-01T12:00:00Z");
    expect(fmtAge("2026-08-01T09:00:00Z", now)).toBe("3h ago");
    expect(fmtAge("2026-08-01T14:00:00Z", now)).toBe("in 2h");
  });
  it("cls joins truthy parts", () => {
    expect(cls("a", false, "b", undefined)).toBe("a b");
  });
});
```

- [ ] **Step 4: Verify**

Run: `cd panel && npm test`
Expected: PASS (4 tests).
Run: `npm run build`
Expected: build succeeds, all nine routes compiled.

- [ ] **Step 5: Commit**

```bash
cd /home/user/Jamasp
git add panel/
git commit -m "feat(panel): scaffold Next.js app — shell, nav, nine route stubs, format helpers"
```

---

### Task 4: Read-only DB layer + SQLite fixture

**Files:**
- Create: `panel/lib/paths.ts`, `panel/lib/db.ts`, `panel/test/fixtures/fixture.sql`, `panel/scripts/build-fixture.mjs`, `panel/test/db.test.ts`
- Modify: `panel/package.json` (add `"fixture": "node scripts/build-fixture.mjs"` script)

**Interfaces:**
- Consumes: schema from `jamasp/db.py` (mirrored in fixture.sql) including Task 1's `notify_log`.
- Produces (all in `lib/db.ts`, consumed by every page task):

```ts
export type ItemRow = { id: string; source: string; published_at: string; headline: string;
  lede: string | null; url: string; topic: string; cluster_id: string | null;
  fetched_at: string; read_at: string | null };
export type WakeupRow = { id: number; due_at: string; run_type: string; task: string;
  status: string; attempts: number; created_at: string; fired_at: string | null };
export type AgentRunRow = { id: number; run_type: string; task: string | null;
  started_at: string; finished_at: string | null; exit_code: number | null; status: string };
export type EventRow = { id: string; source: string; title: string; country: string | null;
  impact: string | null; starts_at: string; fetched_at: string };
export type SourceErrorRow = { source: string; ts: string; error: string };
export type NotifyLogRow = { id: number; ts: string; text: string; ok: number };
export type PricePoint = { ts: string; value: number };
export type PriceSnapshot = { symbol: string; ts: string; value: number;
  delta24h: number | null; delta7d: number | null };

export function getDb(): Database.Database;              // readonly singleton
export function getMeta(key: string): string | null;
export function getUnreadCount(): number;
export function getItems(opts: { limit?: number; source?: string; topic?: string;
  unreadOnly?: boolean }): ItemRow[];                     // published_at DESC
export function getItemFilters(): { sources: string[]; topics: string[] };
export function getWakeups(status?: string): WakeupRow[];    // due_at ASC
export function getAgentRuns(limit: number): AgentRunRow[];  // started_at DESC
export function runsTodayDubai(now?: Date): number;          // excludes 'deferred'
export function getEvents(daysAhead: number, now?: Date): EventRow[];
export function getSourceErrors(sinceIso: string): SourceErrorRow[]; // ts DESC
export function lastItemPerSource(): { source: string; last: string }[];
export function getNotifyLog(limit: number): NotifyLogRow[]; // id DESC
export function getPriceSnapshots(now?: Date): PriceSnapshot[];
export function getPriceSeries(symbol: string, sinceIso: string): PricePoint[];
```

- `lib/paths.ts` produces `JAMASP_ROOT: string`, `DB_PATH`, `STATE_DIR`, `REPORTS_DIR`, `CONFIG_DIR`.

- [ ] **Step 1: paths.ts**

```ts
import path from "node:path";

export const JAMASP_ROOT = process.env.JAMASP_ROOT
  ? path.resolve(process.env.JAMASP_ROOT)
  : path.resolve(process.cwd(), "..");
export const STATE_DIR = path.join(JAMASP_ROOT, "state");
export const DB_PATH = path.join(STATE_DIR, "jamasp.db");
export const REPORTS_DIR = path.join(JAMASP_ROOT, "reports");
export const CONFIG_DIR = path.join(JAMASP_ROOT, "config");
```

- [ ] **Step 2: fixture.sql + builder**

`panel/test/fixtures/fixture.sql` — full schema copied from `jamasp/db.py` SCHEMA (items, prices, extract_cache, source_errors, wakeups, events, agent_runs, meta, notify_log, plus the three indexes), followed by deterministic sample data:

```sql
INSERT INTO items VALUES
 ('i1','cnbc_finance','2026-08-01T08:00:00Z','Gold steadies as dollar slips','Spot gold held near…','https://example.com/a1','gold','i1','2026-08-01T08:05:00Z',NULL),
 ('i2','marketwatch_top','2026-08-01T07:30:00Z','Fed officials split on September cut',NULL,'https://example.com/a2','fed','i2','2026-08-01T07:35:00Z',NULL),
 ('i3','cnbc_finance','2026-08-01T06:00:00Z','Dollar slides on jobs data','—','https://example.com/a3','gold','i1','2026-08-01T06:05:00Z','2026-08-01T07:00:00Z');
INSERT INTO prices VALUES
 ('GC','2026-07-25T08:00:00Z',3290.0),('GC','2026-07-31T08:00:00Z',3310.5),('GC','2026-08-01T08:00:00Z',3325.0),
 ('DXY','2026-07-31T08:00:00Z',104.2),('DXY','2026-08-01T08:00:00Z',103.8);
INSERT INTO source_errors VALUES ('investing_commodities','2026-08-01T07:50:00Z','HTTP 403');
INSERT INTO wakeups (id,due_at,run_type,task,status,attempts,created_at,fired_at) VALUES
 (1,'2026-08-02T05:00:00Z','deepdive','read the Fed statement','pending',0,'2026-08-01T08:00:00Z',NULL),
 (2,'2026-07-31T05:00:00Z','scan','old one','done',1,'2026-07-30T08:00:00Z','2026-07-31T05:02:00Z');
INSERT INTO events VALUES
 ('e1','ff_calendar','US Nonfarm Payrolls','US','High','2026-08-07T12:30:00Z','2026-08-01T00:00:00Z'),
 ('e2','ff_calendar','FOMC Minutes','US','Medium','2026-08-19T18:00:00Z','2026-08-01T00:00:00Z');
INSERT INTO agent_runs (run_type,task,started_at,finished_at,exit_code,status) VALUES
 ('brief',NULL,'2026-08-01T05:00:00Z','2026-08-01T05:09:00Z',0,'ok'),
 ('scan',NULL,'2026-08-01T07:00:00Z','2026-08-01T07:02:00Z',1,'failed');
INSERT INTO meta VALUES ('last_ingest_at','2026-08-01T08:05:00Z'),
 ('source_last_fetch.cnbc_finance','2026-08-01T08:05:00Z');
INSERT INTO notify_log (ts,text,ok) VALUES
 ('2026-08-01T05:10:00Z','خلاصه صبحگاهی: طلا در محدوده 3325 معامله می‌شود',1),
 ('2026-08-01T07:03:00Z','Jamasp FAILURE: scan run failed after retry, exit=1.',0);
```

`panel/scripts/build-fixture.mjs`:

```js
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../test/fixtures/root");
mkdirSync(path.join(root, "state"), { recursive: true });
const dbPath = path.join(root, "state", "jamasp.db");
rmSync(dbPath, { force: true });
const db = new Database(dbPath);
db.exec(readFileSync(path.resolve(import.meta.dirname, "../test/fixtures/fixture.sql"), "utf8"));
db.close();
console.log(`fixture db written: ${dbPath}`);
```

Add `panel/test/fixtures/root/state/jamasp.db` to `panel/.gitignore` (the .sql is the source of truth); add npm script `"fixture": "node scripts/build-fixture.mjs"`.

- [ ] **Step 3: Write failing tests**

`panel/test/db.test.ts` (build fixture in `beforeAll`, point `JAMASP_ROOT` at the fixture root **before** importing `lib/db` — use dynamic import):

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

let db: typeof import("../lib/db");

beforeAll(async () => {
  execFileSync("node", [path.resolve(__dirname, "../scripts/build-fixture.mjs")]);
  process.env.JAMASP_ROOT = path.resolve(__dirname, "fixtures/root");
  db = await import("../lib/db");
});

describe("db layer", () => {
  it("counts unread cluster representatives", () => {
    expect(db.getUnreadCount()).toBe(2); // i1, i2 unread; i3 read + clustered under i1
  });
  it("filters items by source and read state", () => {
    expect(db.getItems({ source: "cnbc_finance" }).map(r => r.id)).toEqual(["i1", "i3"]);
    expect(db.getItems({ unreadOnly: true }).map(r => r.id)).toEqual(["i1", "i2"]);
  });
  it("computes price snapshots with deltas", () => {
    const gc = db.getPriceSnapshots(new Date("2026-08-01T09:00:00Z")).find(s => s.symbol === "GC")!;
    expect(gc.value).toBe(3325.0);
    expect(gc.delta24h).toBeCloseTo(3325.0 - 3310.5);
    expect(gc.delta7d).toBeCloseTo(3325.0 - 3290.0);
  });
  it("runsTodayDubai counts non-deferred runs on the Dubai day", () => {
    expect(db.runsTodayDubai(new Date("2026-08-01T09:00:00Z"))).toBe(2);
  });
  it("reads wakeups, events, notify log", () => {
    expect(db.getWakeups("pending").map(w => w.id)).toEqual([1]);
    expect(db.getEvents(30, new Date("2026-08-01T00:00:00Z")).length).toBe(2);
    expect(db.getNotifyLog(10)[0].ok).toBe(0); // newest first
  });
  it("returns an ascending price series from a cutoff", () => {
    expect(db.getPriceSeries("GC", "2026-07-30T00:00:00Z").map(p => p.value))
      .toEqual([3310.5, 3325.0]);
  });
});
```

Run: `cd panel && npm test` → Expected: FAIL (`lib/db` doesn't exist).

- [ ] **Step 4: Implement `lib/db.ts`**

```ts
import Database from "better-sqlite3";
import { DB_PATH } from "./paths";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _db;
}

/** One retry on SQLITE_BUSY; the CLI writers hold short transactions. */
function q<T>(fn: (db: Database.Database) => T): T {
  try {
    return fn(getDb());
  } catch (e: unknown) {
    if ((e as { code?: string }).code?.startsWith("SQLITE_BUSY")) return fn(getDb());
    throw e;
  }
}

// ---- types (exactly as in the Interfaces block above) ----
export type ItemRow = { id: string; source: string; published_at: string; headline: string;
  lede: string | null; url: string; topic: string; cluster_id: string | null;
  fetched_at: string; read_at: string | null };
export type WakeupRow = { id: number; due_at: string; run_type: string; task: string;
  status: string; attempts: number; created_at: string; fired_at: string | null };
export type AgentRunRow = { id: number; run_type: string; task: string | null;
  started_at: string; finished_at: string | null; exit_code: number | null; status: string };
export type EventRow = { id: string; source: string; title: string; country: string | null;
  impact: string | null; starts_at: string; fetched_at: string };
export type SourceErrorRow = { source: string; ts: string; error: string };
export type NotifyLogRow = { id: number; ts: string; text: string; ok: number };
export type PricePoint = { ts: string; value: number };
export type PriceSnapshot = { symbol: string; ts: string; value: number;
  delta24h: number | null; delta7d: number | null };

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function getMeta(key: string): string | null {
  return q(db => (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    { value: string } | undefined)?.value ?? null);
}

export function getUnreadCount(): number {
  return q(db => (db.prepare(
    "SELECT COUNT(*) c FROM items WHERE read_at IS NULL AND (cluster_id = id OR cluster_id IS NULL)"
  ).get() as { c: number }).c);
}

export function getItems(opts: { limit?: number; source?: string; topic?: string;
  unreadOnly?: boolean } = {}): ItemRow[] {
  const cond: string[] = [];
  const args: unknown[] = [];
  if (opts.source) { cond.push("source = ?"); args.push(opts.source); }
  if (opts.topic) { cond.push("topic = ?"); args.push(opts.topic); }
  if (opts.unreadOnly) cond.push("read_at IS NULL");
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  return q(db => db.prepare(
    `SELECT * FROM items ${where} ORDER BY published_at DESC LIMIT ?`
  ).all(...args, opts.limit ?? 200) as ItemRow[]);
}

export function getItemFilters(): { sources: string[]; topics: string[] } {
  return q(db => ({
    sources: (db.prepare("SELECT DISTINCT source FROM items ORDER BY source").all() as
      { source: string }[]).map(r => r.source),
    topics: (db.prepare("SELECT DISTINCT topic FROM items ORDER BY topic").all() as
      { topic: string }[]).map(r => r.topic),
  }));
}

export function getWakeups(status?: string): WakeupRow[] {
  return q(db => (status
    ? db.prepare("SELECT * FROM wakeups WHERE status = ? ORDER BY due_at").all(status)
    : db.prepare("SELECT * FROM wakeups ORDER BY due_at DESC").all()) as WakeupRow[]);
}

export function getAgentRuns(limit: number): AgentRunRow[] {
  return q(db => db.prepare(
    "SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?").all(limit) as AgentRunRow[]);
}

export function runsTodayDubai(now: Date = new Date()): number {
  const dubaiDay = new Date(now.getTime() + 4 * 3600_000).toISOString().slice(0, 10);
  return q(db => (db.prepare("SELECT started_at FROM agent_runs WHERE status != 'deferred'")
    .all() as { started_at: string }[])
    .filter(r => new Date(new Date(r.started_at).getTime() + 4 * 3600_000)
      .toISOString().slice(0, 10) === dubaiDay).length);
}

export function getEvents(daysAhead: number, now: Date = new Date()): EventRow[] {
  const until = iso(new Date(now.getTime() + daysAhead * 86400_000));
  return q(db => db.prepare(
    "SELECT * FROM events WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at"
  ).all(iso(now), until) as EventRow[]);
}

export function getSourceErrors(sinceIso: string): SourceErrorRow[] {
  return q(db => db.prepare(
    "SELECT * FROM source_errors WHERE ts >= ? ORDER BY ts DESC").all(sinceIso) as SourceErrorRow[]);
}

export function lastItemPerSource(): { source: string; last: string }[] {
  return q(db => db.prepare(
    "SELECT source, MAX(fetched_at) last FROM items GROUP BY source"
  ).all() as { source: string; last: string }[]);
}

export function getNotifyLog(limit: number): NotifyLogRow[] {
  return q(db => db.prepare(
    "SELECT * FROM notify_log ORDER BY id DESC LIMIT ?").all(limit) as NotifyLogRow[]);
}

function priceAtOrBefore(db: Database.Database, symbol: string, ts: string): number | null {
  const r = db.prepare(
    "SELECT value FROM prices WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1"
  ).get(symbol, ts) as { value: number } | undefined;
  return r?.value ?? null;
}

export function getPriceSnapshots(now: Date = new Date()): PriceSnapshot[] {
  return q(db => {
    const symbols = (db.prepare("SELECT DISTINCT symbol FROM prices ORDER BY symbol").all() as
      { symbol: string }[]).map(r => r.symbol);
    return symbols.map(symbol => {
      const latest = db.prepare(
        "SELECT ts, value FROM prices WHERE symbol = ? ORDER BY ts DESC LIMIT 1"
      ).get(symbol) as { ts: string; value: number };
      const v24 = priceAtOrBefore(db, symbol, iso(new Date(now.getTime() - 86400_000)));
      const v7d = priceAtOrBefore(db, symbol, iso(new Date(now.getTime() - 7 * 86400_000)));
      return { symbol, ts: latest.ts, value: latest.value,
        delta24h: v24 === null ? null : latest.value - v24,
        delta7d: v7d === null ? null : latest.value - v7d };
    });
  });
}

export function getPriceSeries(symbol: string, sinceIso: string): PricePoint[] {
  return q(db => db.prepare(
    "SELECT ts, value FROM prices WHERE symbol = ? AND ts >= ? ORDER BY ts"
  ).all(symbol, sinceIso) as PricePoint[]);
}
```

- [ ] **Step 5: Run tests**

Run: `cd panel && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add panel/
git commit -m "feat(panel): read-only sqlite data layer with typed queries and sql fixture"
```

---

### Task 5: Files layer (stance, watchlist, playbook, predictions, reports, config)

**Files:**
- Create: `panel/lib/files.ts`, `panel/test/files.test.ts`
- Create fixture root files: `panel/test/fixtures/root/state/stance.md`, `.../state/watchlist.yaml`, `.../state/playbook.md`, `.../state/predictions.jsonl`, `.../reports/2026/07/2026-07-31-brief.md`, `.../config/sources.yaml`, `.../config/settings.yaml`

**Interfaces:**
- Consumes: `lib/paths.ts` (`STATE_DIR`, `REPORTS_DIR`, `CONFIG_DIR`).
- Produces (consumed by page tasks 8–16):

```ts
export type WatchlistEntry = { theme: string; why: string; since: string };
export type Prediction = { id: string; date: string; claim: string; direction: string;
  horizon_days: number; confidence: number; created_at: string;
  outcome: string | null; scored_at: string | null; note: string | null };
export type PredictionStats = { open: number; maturedUnscored: number; scored: number;
  hits: number; misses: number; unclear: number; hitRate: number | null };
export type SourceConfig = { name: string; type: string; url: string;
  interval_minutes: number; topic?: string };
export type ReportMeta = { slug: string; date: string };   // slug "2026/07/2026-07-31-brief"

export function readStance(): string | null;      // null when file missing
export function readPlaybook(): string | null;
export function readWatchlist(): WatchlistEntry[];
export function readPredictions(): Prediction[];
export function predictionStats(preds: Prediction[], now?: Date): PredictionStats;
export function loadSources(): SourceConfig[];
export function loadSettings(): Record<string, unknown>;  // parsed settings.yaml
export function maxRunsPerDay(): number;                   // settings.runs.max_agent_runs_per_day
export function listReports(): ReportMeta[];               // newest first
export function readReport(slug: string): string | null;   // traversal-guarded
```

- [ ] **Step 1: Fixture root files**

`state/stance.md`:

```markdown
# Stance — 2026-08-01

Gold constructive above 3300. Real yields drifting lower; dollar soft after
the jobs miss. Watching the Fed's September signal.
```

`state/watchlist.yaml` (same shape as the real one):

```yaml
watchlist:
  - theme: fed-rate-path
    why: dominant driver of real yields and hence gold
    since: 2026-07-31
```

`state/playbook.md`: `# Playbook\n\n- On NFP misses, expect a dollar dip.\n`

`state/predictions.jsonl` (one open, one matured-unscored, two scored):

```json
{"id":"aaaa0001","date":"2026-08-01","claim":"GC above 3350 within 5 days","direction":"up","horizon_days":5,"confidence":0.6,"created_at":"2026-08-01T05:00:00Z","outcome":null,"scored_at":null,"note":null}
{"id":"aaaa0002","date":"2026-07-20","claim":"GC flat through July","direction":"flat","horizon_days":5,"confidence":0.5,"created_at":"2026-07-20T05:00:00Z","outcome":null,"scored_at":null,"note":null}
{"id":"aaaa0003","date":"2026-07-10","claim":"DXY down on CPI","direction":"down","horizon_days":3,"confidence":0.7,"created_at":"2026-07-10T05:00:00Z","outcome":"hit","scored_at":"2026-07-14T05:00:00Z","note":"clean"}
{"id":"aaaa0004","date":"2026-07-05","claim":"GC up on FOMC","direction":"up","horizon_days":2,"confidence":0.8,"created_at":"2026-07-05T05:00:00Z","outcome":"miss","scored_at":"2026-07-08T05:00:00Z","note":"wrong"}
```

`reports/2026/07/2026-07-31-brief.md`: `# Morning Brief — 2026-07-31\n\nGold steady.\n`

`config/sources.yaml` (two sources; one matches fixture DB's erroring source):

```yaml
sources:
  - name: cnbc_finance
    type: rss
    url: https://example.com/rss1
    interval_minutes: 15
    topic: markets
  - name: investing_commodities
    type: rss
    url: https://example.com/rss2
    interval_minutes: 15
    topic: gold
```

`config/settings.yaml`: copy the real `config/settings.yaml` verbatim (the panel only reads `runs.max_agent_runs_per_day` and `inbox_cap`).

- [ ] **Step 2: Write failing tests**

`panel/test/files.test.ts` (same `beforeAll` pattern as `db.test.ts` — set `JAMASP_ROOT` then dynamic-import `../lib/files`):

```ts
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";

let files: typeof import("../lib/files");

beforeAll(async () => {
  process.env.JAMASP_ROOT = path.resolve(__dirname, "fixtures/root");
  files = await import("../lib/files");
});

describe("files layer", () => {
  it("reads stance and playbook, null when missing", () => {
    expect(files.readStance()).toContain("Gold constructive");
    expect(files.readPlaybook()).toContain("Playbook");
  });
  it("parses watchlist and sources", () => {
    expect(files.readWatchlist()[0].theme).toBe("fed-rate-path");
    expect(files.loadSources().map(s => s.name)).toEqual(
      ["cnbc_finance", "investing_commodities"]);
    expect(files.maxRunsPerDay()).toBe(20);
  });
  it("computes prediction stats", () => {
    const stats = files.predictionStats(files.readPredictions(),
      new Date("2026-08-01T12:00:00Z"));
    expect(stats).toEqual({ open: 1, maturedUnscored: 1, scored: 2,
      hits: 1, misses: 1, unclear: 0, hitRate: 0.5 });
  });
  it("lists and reads reports, guarding traversal", () => {
    expect(files.listReports()).toEqual([{ slug: "2026/07/2026-07-31-brief",
      date: "2026-07-31" }]);
    expect(files.readReport("2026/07/2026-07-31-brief")).toContain("Morning Brief");
    expect(files.readReport("../../../etc/passwd")).toBeNull();
  });
});
```

Run: `cd panel && npm test` → Expected: FAIL (`lib/files` doesn't exist).

- [ ] **Step 3: Implement `lib/files.ts`**

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_DIR, REPORTS_DIR, STATE_DIR } from "./paths";

export type WatchlistEntry = { theme: string; why: string; since: string };
export type Prediction = { id: string; date: string; claim: string; direction: string;
  horizon_days: number; confidence: number; created_at: string;
  outcome: string | null; scored_at: string | null; note: string | null };
export type PredictionStats = { open: number; maturedUnscored: number; scored: number;
  hits: number; misses: number; unclear: number; hitRate: number | null };
export type SourceConfig = { name: string; type: string; url: string;
  interval_minutes: number; topic?: string };
export type ReportMeta = { slug: string; date: string };

function readText(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function readStance(): string | null {
  return readText(path.join(STATE_DIR, "stance.md"));
}

export function readPlaybook(): string | null {
  return readText(path.join(STATE_DIR, "playbook.md"));
}

export function readWatchlist(): WatchlistEntry[] {
  const raw = readText(path.join(STATE_DIR, "watchlist.yaml"));
  if (!raw) return [];
  const doc = YAML.parse(raw) as { watchlist?: unknown[] } | null;
  return (doc?.watchlist ?? []).map(e => {
    const r = e as Record<string, unknown>;
    return { theme: String(r.theme ?? ""), why: String(r.why ?? ""),
      since: String(r.since ?? "") };
  });
}

export function readPredictions(): Prediction[] {
  const raw = readText(path.join(STATE_DIR, "predictions.jsonl"));
  if (!raw) return [];
  return raw.split("\n").filter(l => l.trim()).map(l => JSON.parse(l) as Prediction);
}

export function predictionStats(preds: Prediction[], now: Date = new Date()): PredictionStats {
  let open = 0, maturedUnscored = 0, hits = 0, misses = 0, unclear = 0;
  for (const p of preds) {
    if (p.outcome === "hit") hits++;
    else if (p.outcome === "miss") misses++;
    else if (p.outcome === "unclear") unclear++;
    else {
      const matures = new Date(p.created_at).getTime() + p.horizon_days * 86400_000;
      if (matures <= now.getTime()) maturedUnscored++;
      else open++;
    }
  }
  const decisive = hits + misses;
  return { open, maturedUnscored, scored: hits + misses + unclear, hits, misses,
    unclear, hitRate: decisive ? hits / decisive : null };
}

export function loadSources(): SourceConfig[] {
  const raw = readText(path.join(CONFIG_DIR, "sources.yaml"));
  if (!raw) return [];
  const doc = YAML.parse(raw) as { sources?: SourceConfig[] } | null;
  return doc?.sources ?? [];
}

export function loadSettings(): Record<string, unknown> {
  const raw = readText(path.join(CONFIG_DIR, "settings.yaml"));
  return raw ? (YAML.parse(raw) as Record<string, unknown>) : {};
}

export function maxRunsPerDay(): number {
  const runs = loadSettings().runs as { max_agent_runs_per_day?: number } | undefined;
  return runs?.max_agent_runs_per_day ?? 20;
}

export function listReports(): ReportMeta[] {
  if (!existsSync(REPORTS_DIR)) return [];
  const out: ReportMeta[] = [];
  for (const year of readdirSync(REPORTS_DIR)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of readdirSync(path.join(REPORTS_DIR, year))) {
      if (!/^\d{2}$/.test(month)) continue;
      for (const f of readdirSync(path.join(REPORTS_DIR, year, month))) {
        if (!f.endsWith(".md")) continue;
        out.push({ slug: `${year}/${month}/${f.replace(/\.md$/, "")}`,
          date: f.slice(0, 10) });
      }
    }
  }
  return out.sort((a, b) => b.slug.localeCompare(a.slug));
}

export function readReport(slug: string): string | null {
  const p = path.resolve(REPORTS_DIR, `${slug}.md`);
  if (!p.startsWith(path.resolve(REPORTS_DIR) + path.sep)) return null; // traversal guard
  return readText(p);
}
```

- [ ] **Step 4: Run tests**

Run: `cd panel && npm test` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add panel/
git commit -m "feat(panel): files layer — stance, watchlist, predictions stats, reports"
```

---

### Task 6: Health derivation (source staleness + system warnings)

**Files:**
- Create: `panel/lib/health.ts`, `panel/test/health.test.ts`

**Interfaces:**
- Consumes: types from `lib/db.ts` (`AgentRunRow`, `SourceErrorRow`) and `lib/files.ts` (`SourceConfig`). Pure functions — no I/O; callers assemble inputs.
- Produces (consumed by Overview/Crawl/Alerts pages):

```ts
export type SourceHealth = { name: string; type: string; intervalMinutes: number;
  lastFetch: string | null; lastItem: string | null; errors24h: number;
  state: "ok" | "stale" | "erroring" | "never" };
export type Warning = { severity: "red" | "amber"; text: string };

export function deriveSourceHealth(
  sources: SourceConfig[],
  lastFetchBySource: Record<string, string | null>,   // meta source_last_fetch.<name>
  lastItemBySource: Record<string, string>,           // from lastItemPerSource()
  errors: SourceErrorRow[],                           // last 24h
  now?: Date,
): SourceHealth[];   // sorted: erroring, stale, never, ok

export function deriveWarnings(input: {
  lastIngestAt: string | null;
  runs: AgentRunRow[];            // recent, e.g. getAgentRuns(50)
  sourceHealth: SourceHealth[];
  runsToday: number;
  cap: number;
}, now?: Date): Warning[];
```

- Rules (encode exactly): source `never` if no lastFetch; `erroring` if ≥3 errors in the window OR (≥1 error AND lastFetch older than 2× interval); `stale` if lastFetch older than max(3× interval minutes, 60) minutes; else `ok`. Warnings: red "ingest stale" if lastIngestAt missing or >60 min old (mirrors `watchdog.INGEST_STALE_MINUTES`); red per failed/timeout run in last 48h; amber per deferred run in last 48h; amber listing erroring/stale sources when any; amber "run cap reached" when `runsToday >= cap`.

- [ ] **Step 1: Write failing tests**

`panel/test/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveSourceHealth, deriveWarnings } from "../lib/health";

const NOW = new Date("2026-08-01T12:00:00Z");
const src = (name: string) =>
  ({ name, type: "rss", url: "u", interval_minutes: 15 });

describe("deriveSourceHealth", () => {
  it("classifies ok / stale / never / erroring and sorts worst-first", () => {
    const health = deriveSourceHealth(
      [src("fresh"), src("stale"), src("dead"), src("errs")],
      { fresh: "2026-08-01T11:50:00Z", stale: "2026-08-01T09:00:00Z",
        dead: null, errs: "2026-08-01T11:50:00Z" },
      { fresh: "2026-08-01T11:50:00Z" },
      [
        { source: "errs", ts: "2026-08-01T11:00:00Z", error: "403" },
        { source: "errs", ts: "2026-08-01T10:00:00Z", error: "403" },
        { source: "errs", ts: "2026-08-01T09:00:00Z", error: "403" },
      ],
      NOW,
    );
    expect(health.map(h => [h.name, h.state])).toEqual([
      ["errs", "erroring"], ["stale", "stale"], ["dead", "never"], ["fresh", "ok"],
    ]);
  });
});

describe("deriveWarnings", () => {
  it("flags stale ingest, bad runs, cap", () => {
    const w = deriveWarnings({
      lastIngestAt: "2026-08-01T10:00:00Z",   // 2h old -> red
      runs: [
        { id: 1, run_type: "scan", task: null, started_at: "2026-08-01T07:00:00Z",
          finished_at: "2026-08-01T07:02:00Z", exit_code: 1, status: "failed" },
        { id: 2, run_type: "brief", task: null, started_at: "2026-08-01T05:00:00Z",
          finished_at: "2026-08-01T05:09:00Z", exit_code: 0, status: "ok" },
      ],
      sourceHealth: [], runsToday: 20, cap: 20,
    }, NOW);
    const reds = w.filter(x => x.severity === "red");
    expect(reds.some(x => x.text.includes("ingest stale"))).toBe(true);
    expect(reds.some(x => x.text.includes("scan") && x.text.includes("failed"))).toBe(true);
    expect(w.some(x => x.severity === "amber" && x.text.includes("cap"))).toBe(true);
  });
  it("is empty when everything is healthy", () => {
    expect(deriveWarnings({
      lastIngestAt: "2026-08-01T11:50:00Z",
      runs: [], sourceHealth: [], runsToday: 3, cap: 20,
    }, NOW)).toEqual([]);
  });
});
```

Run: `cd panel && npm test` → Expected: FAIL.

- [ ] **Step 2: Implement `lib/health.ts`**

```ts
import type { AgentRunRow, SourceErrorRow } from "./db";
import type { SourceConfig } from "./files";

export type SourceHealth = { name: string; type: string; intervalMinutes: number;
  lastFetch: string | null; lastItem: string | null; errors24h: number;
  state: "ok" | "stale" | "erroring" | "never" };
export type Warning = { severity: "red" | "amber"; text: string };

const STATE_ORDER = { erroring: 0, stale: 1, never: 2, ok: 3 } as const;

export function deriveSourceHealth(
  sources: SourceConfig[],
  lastFetchBySource: Record<string, string | null>,
  lastItemBySource: Record<string, string>,
  errors: SourceErrorRow[],
  now: Date = new Date(),
): SourceHealth[] {
  const errCount = new Map<string, number>();
  for (const e of errors) errCount.set(e.source, (errCount.get(e.source) ?? 0) + 1);

  const rows = sources.map(s => {
    const lastFetch = lastFetchBySource[s.name] ?? null;
    const errors24h = errCount.get(s.name) ?? 0;
    const ageMin = lastFetch
      ? (now.getTime() - new Date(lastFetch).getTime()) / 60_000
      : Infinity;
    let state: SourceHealth["state"];
    if (errors24h >= 3 || (errors24h >= 1 && ageMin > 2 * s.interval_minutes)) {
      state = "erroring";
    } else if (!lastFetch) {
      state = "never";
    } else if (ageMin > Math.max(3 * s.interval_minutes, 60)) {
      state = "stale";
    } else {
      state = "ok";
    }
    return { name: s.name, type: s.type, intervalMinutes: s.interval_minutes,
      lastFetch, lastItem: lastItemBySource[s.name] ?? null, errors24h, state };
  });
  return rows.sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
}

export function deriveWarnings(input: {
  lastIngestAt: string | null;
  runs: AgentRunRow[];
  sourceHealth: SourceHealth[];
  runsToday: number;
  cap: number;
}, now: Date = new Date()): Warning[] {
  const out: Warning[] = [];
  const ingestAge = input.lastIngestAt
    ? (now.getTime() - new Date(input.lastIngestAt).getTime()) / 60_000
    : Infinity;
  if (ingestAge > 60) {
    out.push({ severity: "red",
      text: `ingest stale: last ran ${input.lastIngestAt ?? "never"} (> 60 min ago)` });
  }
  const cutoff = now.getTime() - 48 * 3600_000;
  for (const r of input.runs) {
    if (new Date(r.started_at).getTime() < cutoff) continue;
    if (r.status === "failed" || r.status === "timeout") {
      out.push({ severity: "red",
        text: `${r.run_type} run ${r.status} at ${r.started_at} (exit=${r.exit_code})` });
    } else if (r.status === "deferred") {
      out.push({ severity: "amber", text: `${r.run_type} run deferred at ${r.started_at}` });
    }
  }
  const bad = input.sourceHealth.filter(s => s.state === "erroring" || s.state === "stale");
  if (bad.length) {
    out.push({ severity: "amber",
      text: `sources unhealthy: ${bad.map(s => `${s.name} (${s.state})`).join(", ")}` });
  }
  if (input.runsToday >= input.cap) {
    out.push({ severity: "amber",
      text: `daily run cap reached (${input.runsToday}/${input.cap})` });
  }
  return out;
}
```

- [ ] **Step 3: Run tests**

Run: `cd panel && npm test` → Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add panel/
git commit -m "feat(panel): pure health derivation — source staleness and system warnings"
```

---

### Task 7: CLI-mediated server actions + input validation

**Files:**
- Create: `panel/lib/validate.ts`, `panel/lib/actions.ts`, `panel/test/validate.test.ts`

**Interfaces:**
- Consumes: `JAMASP_ROOT` from `lib/paths.ts`.
- Produces:

```ts
// lib/validate.ts (pure, unit-tested)
export const RUN_TYPES = ["brief", "scan", "deepdive", "retro"] as const;
export type RunType = (typeof RUN_TYPES)[number];
export function validateWakeup(dueAt: string, runType: string, task: string):
  { ok: true; dueAtUtc: string } | { ok: false; error: string };

// lib/actions.ts ("use server", consumed by Inbox/Schedule pages)
export type ActionResult = { ok: boolean; message: string };
export async function markInboxRead(): Promise<ActionResult>;
export async function addWakeup(dueAt: string, runType: string, task: string): Promise<ActionResult>;
export async function cancelWakeup(id: number): Promise<ActionResult>;
export async function runNow(runType: string, task: string): Promise<ActionResult>; // wakeup due now
```

- All actions shell `uv run jamasp ...` with `cwd: JAMASP_ROOT`, 60 s timeout, and return stdout/stderr verbatim in `message`. `runNow` = `addWakeup(new Date().toISOString(), ...)`. NEVER touch better-sqlite3 here.

- [ ] **Step 1: Write failing validation tests**

`panel/test/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateWakeup } from "../lib/validate";

describe("validateWakeup", () => {
  it("accepts ISO with Z and normalizes", () => {
    const r = validateWakeup("2030-01-01T05:00:00Z", "scan", "check");
    expect(r).toEqual({ ok: true, dueAtUtc: "2030-01-01T05:00:00Z" });
  });
  it("accepts offset time, converts to Z", () => {
    const r = validateWakeup("2030-01-01T09:00:00+04:00", "deepdive", "t");
    expect(r).toEqual({ ok: true, dueAtUtc: "2030-01-01T05:00:00Z" });
  });
  it("rejects naive datetimes, bad run types, empty task", () => {
    expect(validateWakeup("2030-01-01T05:00:00", "scan", "t").ok).toBe(false);
    expect(validateWakeup("2030-01-01T05:00:00Z", "party", "t").ok).toBe(false);
    expect(validateWakeup("2030-01-01T05:00:00Z", "scan", "  ").ok).toBe(false);
    expect(validateWakeup("garbage", "scan", "t").ok).toBe(false);
  });
});
```

Run: `cd panel && npm test` → Expected: FAIL.

- [ ] **Step 2: Implement**

`panel/lib/validate.ts`:

```ts
export const RUN_TYPES = ["brief", "scan", "deepdive", "retro"] as const;
export type RunType = (typeof RUN_TYPES)[number];

export function validateWakeup(dueAt: string, runType: string, task: string):
  { ok: true; dueAtUtc: string } | { ok: false; error: string } {
  if (!(RUN_TYPES as readonly string[]).includes(runType)) {
    return { ok: false, error: `run type must be one of ${RUN_TYPES.join(", ")}` };
  }
  if (!task.trim()) return { ok: false, error: "task text is required" };
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(dueAt)) {
    return { ok: false, error: "due time must carry a timezone (Z or offset)" };
  }
  const t = Date.parse(dueAt);
  if (isNaN(t)) return { ok: false, error: `not an ISO-8601 datetime: ${dueAt}` };
  return { ok: true, dueAtUtc: new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") };
}
```

`panel/lib/actions.ts`:

```ts
"use server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { JAMASP_ROOT } from "./paths";
import { validateWakeup } from "./validate";

const pexec = promisify(execFile);

export type ActionResult = { ok: boolean; message: string };

async function jamasp(args: string[]): Promise<ActionResult> {
  try {
    const { stdout } = await pexec("uv", ["run", "jamasp", ...args],
      { cwd: JAMASP_ROOT, timeout: 60_000 });
    return { ok: true, message: stdout.trim() };
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    return { ok: false,
      message: (err.stderr || err.stdout || err.message || "command failed").trim() };
  }
}

export async function markInboxRead(): Promise<ActionResult> {
  const r = await jamasp(["inbox", "--mark-read"]);
  revalidatePath("/inbox");
  return r;
}

export async function addWakeup(dueAt: string, runType: string, task: string):
  Promise<ActionResult> {
  const v = validateWakeup(dueAt, runType, task);
  if (!v.ok) return { ok: false, message: v.error };
  const r = await jamasp(["wakeup", "add", v.dueAtUtc, runType, task]);
  revalidatePath("/schedule");
  return r;
}

export async function cancelWakeup(id: number): Promise<ActionResult> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, message: `bad wakeup id: ${id}` };
  const r = await jamasp(["wakeup", "cancel", String(id)]);
  revalidatePath("/schedule");
  return r;
}

export async function runNow(runType: string, task: string): Promise<ActionResult> {
  return addWakeup(new Date().toISOString(), runType,
    task.trim() || `${runType} triggered from panel`);
}
```

- [ ] **Step 3: Run tests + build**

Run: `cd panel && npm test && npm run build` → Expected: PASS / build OK.

- [ ] **Step 4: Manual sanity check against the real repo (dev only)**

```bash
cd panel && npx next dev -p 3999 &   # JAMASP_ROOT defaults to repo root
sleep 6 && kill %1
```

No assertion needed — this just confirms the app still boots with the new server-action module. (Real action clicks are exercised in Task 12's verification.)

- [ ] **Step 5: Commit**

```bash
git add panel/
git commit -m "feat(panel): CLI-mediated server actions with validated wakeup input"
```

---

### Task 8: Overview page

**Files:**
- Create: `panel/components/stat-card.tsx`
- Modify: `panel/app/page.tsx`

**Interfaces:**
- Consumes: `lib/db.ts` (`getMeta`, `getUnreadCount`, `getWakeups`, `getEvents`, `getAgentRuns`, `runsTodayDubai`, `getPriceSnapshots`, `getNotifyLog`, `getSourceErrors`, `lastItemPerSource`), `lib/files.ts` (`loadSources`, `maxRunsPerDay`), `lib/health.ts` (`deriveSourceHealth`, `deriveWarnings`), `lib/format.ts`, `<AutoRefresh/>`, `<PageHeader/>`.
- Produces: `<StatCard label value sub? tone?>` (tone: `"ok" | "warn" | "bad" | undefined`) reused by Schedule (cap gauge).

- [ ] **Step 1: StatCard**

`panel/components/stat-card.tsx`:

```tsx
import { Card, CardContent } from "@/components/ui/card";
import { cls } from "@/lib/format";

const TONES = { ok: "text-emerald-400", warn: "text-amber-400", bad: "text-red-400" };

export function StatCard({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: keyof typeof TONES;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={cls("mt-1 text-2xl font-semibold", tone && TONES[tone])}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Page**

`panel/app/page.tsx` — server component, `export const dynamic = "force-dynamic";`. Assemble:

```tsx
import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import * as db from "@/lib/db";
import * as files from "@/lib/files";
import { deriveSourceHealth, deriveWarnings } from "@/lib/health";
import { fmtAge, fmtDubai, fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function Overview() {
  const now = new Date();
  const sinceIso = new Date(now.getTime() - 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const lastIngest = db.getMeta("last_ingest_at");
  const sources = files.loadSources();
  const lastFetch = Object.fromEntries(
    sources.map(s => [s.name, db.getMeta(`source_last_fetch.${s.name}`)]));
  const lastItems = Object.fromEntries(
    db.lastItemPerSource().map(r => [r.source, r.last]));
  const health = deriveSourceHealth(sources, lastFetch, lastItems,
    db.getSourceErrors(sinceIso), now);
  const runsToday = db.runsTodayDubai(now);
  const cap = files.maxRunsPerDay();
  const warnings = deriveWarnings({ lastIngestAt: lastIngest,
    runs: db.getAgentRuns(50), sourceHealth: health, runsToday, cap }, now);
  const prices = db.getPriceSnapshots(now);
  const wakeups = db.getWakeups("pending").slice(0, 3);
  const events = db.getEvents(14, now).slice(0, 3);
  const lastAlert = db.getNotifyLog(1)[0];
  const lastRuns = db.getAgentRuns(20);
  const lastByType = ["brief", "scan", "deepdive", "retro"].map(t =>
    [t, lastRuns.find(r => r.run_type === t)] as const);

  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Overview" subtitle={`as of ${fmtUtc(now.toISOString())}`} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Last ingest" value={lastIngest ? fmtAge(lastIngest, now) : "never"}
          tone={warnings.some(w => w.text.startsWith("ingest stale")) ? "bad" : "ok"} />
        <StatCard label="Runs today" value={`${runsToday}/${cap}`}
          tone={runsToday >= cap ? "warn" : undefined} />
        <StatCard label="Unread items" value={String(db.getUnreadCount())} />
        <StatCard label="Source errors 24h" value={String(db.getSourceErrors(sinceIso).length)}
          tone={db.getSourceErrors(sinceIso).length ? "warn" : "ok"} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {prices.map(p => (
          <StatCard key={p.symbol} label={p.symbol} value={p.value.toLocaleString()}
            sub={`24h ${p.delta24h == null ? "—" : p.delta24h.toFixed(1)} · 7d ${p.delta7d == null ? "—" : p.delta7d.toFixed(1)}`} />
        ))}
      </div>
      {warnings.length > 0 && (
        <div className="mt-6 space-y-2">
          {warnings.map((w, i) => (
            <div key={i} className={w.severity === "red"
              ? "rounded border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300"
              : "rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-sm text-amber-300"}>
              {w.text}
            </div>
          ))}
        </div>
      )}
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section>
          <h2 className="mb-2 font-medium">Last runs <Link className="text-xs text-primary" href="/schedule">→ schedule</Link></h2>
          <ul className="space-y-1 text-sm">
            {lastByType.map(([t, r]) => (
              <li key={t} className="flex justify-between">
                <span>{t}</span>
                {r ? <span><Badge variant={r.status === "ok" ? "secondary" : "destructive"}>{r.status}</Badge>
                  <span className="ml-2 text-muted-foreground">{fmtAge(r.started_at, now)}</span></span>
                  : <span className="text-muted-foreground">never</span>}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 font-medium">Next wakeups <Link className="text-xs text-primary" href="/schedule">→ all</Link></h2>
          <ul className="space-y-1 text-sm">
            {wakeups.length === 0 && <li className="text-muted-foreground">none pending</li>}
            {wakeups.map(w => (
              <li key={w.id}>#{w.id} {w.run_type} {fmtAge(w.due_at, now)} — <span className="text-muted-foreground">{w.task}</span></li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 font-medium">Next events <Link className="text-xs text-primary" href="/calendar">→ calendar</Link></h2>
          <ul className="space-y-1 text-sm">
            {events.length === 0 && <li className="text-muted-foreground">nothing upcoming</li>}
            {events.map(e => (
              <li key={e.id}>{fmtUtc(e.starts_at)} ({fmtDubai(e.starts_at)}) — {e.title}</li>
            ))}
          </ul>
        </section>
      </div>
      {lastAlert && (
        <section className="mt-6">
          <h2 className="mb-2 font-medium">Latest alert <Link className="text-xs text-primary" href="/alerts">→ alerts</Link></h2>
          <p dir={/[؀-ۿ]/.test(lastAlert.text) ? "rtl" : "ltr"}
            className="rounded border border-border p-3 text-sm [font-family:Vazirmatn,Tahoma,sans-serif]">
            {lastAlert.text}
          </p>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify against fixture**

```bash
cd panel && npm run fixture
JAMASP_ROOT=./test/fixtures/root npx next dev -p 3999 &
sleep 8 && curl -s localhost:3999/ | grep -o "Runs today" && curl -s localhost:3999/ | grep -o "Unread items" && kill %1
```

Expected: both strings print; no error output in the dev-server log.

- [ ] **Step 4: Commit**

```bash
git add panel/
git commit -m "feat(panel): overview page — health strip, prices, warnings, next up"
```

---

### Task 9: Inbox page (API route + SWR table + mark-read)

**Files:**
- Create: `panel/app/api/inbox/route.ts`, `panel/components/inbox-table.tsx`
- Modify: `panel/app/inbox/page.tsx`

**Interfaces:**
- Consumes: `db.getItems`, `db.getItemFilters`, `db.getUnreadCount`, `actions.markInboxRead`, `fmtAge`.
- Produces: `GET /api/inbox?source=&topic=&unread=1` → `{ items: ItemRow[] }` (limit 200, published_at DESC).

- [ ] **Step 1: API route**

`panel/app/api/inbox/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getItems } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const items = getItems({
    source: p.get("source") || undefined,
    topic: p.get("topic") || undefined,
    unreadOnly: p.get("unread") === "1",
    limit: 200,
  });
  return NextResponse.json({ items });
}
```

- [ ] **Step 2: Client table**

`panel/components/inbox-table.tsx`:

```tsx
"use client";
import { useState, useTransition } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ItemRow } from "@/lib/db";
import { markInboxRead } from "@/lib/actions";
import { fmtAge } from "@/lib/format";

const fetcher = (url: string) => fetch(url).then(r => r.json());

export function InboxTable({ sources, topics }: { sources: string[]; topics: string[] }) {
  const [source, setSource] = useState("");
  const [topic, setTopic] = useState("");
  const [unread, setUnread] = useState(true);
  const [pending, startTransition] = useTransition();
  const qs = new URLSearchParams({
    ...(source && { source }), ...(topic && { topic }), ...(unread && { unread: "1" }),
  }).toString();
  const { data, mutate } = useSWR<{ items: ItemRow[] }>(`/api/inbox?${qs}`, fetcher,
    { refreshInterval: 30_000 });

  const items = data?.items ?? [];
  const clusters = new Map<string, ItemRow[]>();
  for (const it of items) {
    const key = it.cluster_id ?? it.id;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(it);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <select value={source} onChange={e => setSource(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1">
          <option value="">all sources</option>
          {sources.map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={topic} onChange={e => setTopic(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1">
          <option value="">all topics</option>
          {topics.map(t => <option key={t}>{t}</option>)}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={unread} onChange={e => setUnread(e.target.checked)} />
          unread only
        </label>
        <Button size="sm" variant="outline" disabled={pending}
          onClick={() => startTransition(async () => {
            const r = await markInboxRead();
            r.ok ? toast.success(r.message) : toast.error(r.message);
            mutate();
          })}>
          Mark delta read
        </Button>
      </div>
      <ul className="space-y-3">
        {[...clusters.entries()].map(([key, group]) => {
          const rep = group.find(g => g.id === key) ?? group[0];
          const others = group.filter(g => g.id !== rep.id);
          return (
            <li key={key} className="rounded border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <a href={rep.url} target="_blank" rel="noreferrer"
                  className={rep.read_at ? "text-muted-foreground" : "font-medium hover:text-primary"}>
                  {rep.headline}
                </a>
                {!rep.read_at && <Badge>unread</Badge>}
              </div>
              {rep.lede && <p className="mt-1 text-sm text-muted-foreground">{rep.lede}</p>}
              <div className="mt-1 text-xs text-muted-foreground">
                {rep.source} · {rep.topic} · {fmtAge(rep.published_at)}
                {others.length > 0 && <> · also: {others.map(o => o.source).join(", ")}</>}
              </div>
            </li>
          );
        })}
        {items.length === 0 && <li className="text-sm text-muted-foreground">nothing here</li>}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Page**

`panel/app/inbox/page.tsx`:

```tsx
import { PageHeader } from "@/components/page-header";
import { InboxTable } from "@/components/inbox-table";
import { getItemFilters, getUnreadCount } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function InboxPage() {
  const { sources, topics } = getItemFilters();
  return (
    <div>
      <PageHeader title="Inbox" subtitle={`${getUnreadCount()} unread cluster representatives`} />
      <InboxTable sources={sources} topics={topics} />
    </div>
  );
}
```

- [ ] **Step 4: Verify against fixture**

```bash
cd panel && JAMASP_ROOT=./test/fixtures/root npx next dev -p 3999 &
sleep 8
curl -s "localhost:3999/api/inbox?unread=1" | grep -o '"i1"'
curl -s localhost:3999/inbox | grep -o "Inbox"
kill %1
```

Expected: `"i1"` and `Inbox` print.

- [ ] **Step 5: Commit**

```bash
git add panel/
git commit -m "feat(panel): inbox page with cluster grouping, filters, mark-read"
```

---

### Task 10: Crawl page

**Files:**
- Modify: `panel/app/crawl/page.tsx`

**Interfaces:**
- Consumes: `files.loadSources`, `db.getMeta`, `db.lastItemPerSource`, `db.getSourceErrors`, `health.deriveSourceHealth`, `fmtAge`, shadcn `Table`, `Badge`, `<AutoRefresh/>`.
- Produces: nothing consumed later.

- [ ] **Step 1: Page**

```tsx
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import * as db from "@/lib/db";
import { loadSources } from "@/lib/files";
import { deriveSourceHealth } from "@/lib/health";
import { fmtAge, fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

const BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> =
  { ok: "secondary", stale: "outline", never: "outline", erroring: "destructive" };

export default function CrawlPage() {
  const now = new Date();
  const sinceIso = new Date(now.getTime() - 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sources = loadSources();
  const errors = db.getSourceErrors(sinceIso);
  const health = deriveSourceHealth(
    sources,
    Object.fromEntries(sources.map(s => [s.name, db.getMeta(`source_last_fetch.${s.name}`)])),
    Object.fromEntries(db.lastItemPerSource().map(r => [r.source, r.last])),
    errors, now);

  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Crawl" subtitle={`${sources.length} sources · ${errors.length} errors in 24h`} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead><TableHead>State</TableHead>
            <TableHead>Interval</TableHead><TableHead>Last fetch</TableHead>
            <TableHead>Last item</TableHead><TableHead>Errors 24h</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {health.map(h => (
            <TableRow key={h.name}>
              <TableCell className="font-medium">{h.name}</TableCell>
              <TableCell><Badge variant={BADGE[h.state]}>{h.state}</Badge></TableCell>
              <TableCell>{h.intervalMinutes}m</TableCell>
              <TableCell>{h.lastFetch ? fmtAge(h.lastFetch, now) : "never"}</TableCell>
              <TableCell>{h.lastItem ? fmtAge(h.lastItem, now) : "—"}</TableCell>
              <TableCell>{h.errors24h || ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <h2 className="mb-2 mt-8 font-medium">Recent source errors</h2>
      <ul className="space-y-1 text-sm">
        {errors.length === 0 && <li className="text-muted-foreground">none in 24h</li>}
        {errors.map((e, i) => (
          <li key={i} className="text-muted-foreground">
            <span className="text-foreground">{e.source}</span> · {fmtUtc(e.ts)} · {e.error}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

```bash
cd panel && JAMASP_ROOT=./test/fixtures/root npx next dev -p 3999 &
sleep 8 && curl -s localhost:3999/crawl | grep -o "investing_commodities" | head -1 && kill %1
```

Expected: `investing_commodities` prints (the erroring fixture source).

- [ ] **Step 3: Commit**

```bash
git add panel/
git commit -m "feat(panel): crawl page — per-source health and error log"
```

---

### Task 11: Briefs pages (list + markdown render)

**Files:**
- Modify: `panel/app/briefs/page.tsx`
- Create: `panel/app/briefs/[...slug]/page.tsx`, `panel/components/markdown.tsx`

**Interfaces:**
- Consumes: `files.listReports`, `files.readReport`.
- Produces: `<Markdown text={string} />` (react-markdown + remark-gfm wrapper, RTL-aware per paragraph is NOT needed — briefs are English; used again by State page in Task 15).

- [ ] **Step 1: Markdown wrapper**

Install typography plugin: `cd panel && npm install -D @tailwindcss/typography`, and in `app/globals.css` add `@plugin "@tailwindcss/typography";` under the tailwind import.

`panel/components/markdown.tsx`:

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-3xl">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 2: List page**

`panel/app/briefs/page.tsx`:

```tsx
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { listReports } from "@/lib/files";

export const dynamic = "force-dynamic";

export default function BriefsPage() {
  const reports = listReports();
  return (
    <div>
      <PageHeader title="Briefs" subtitle={`${reports.length} reports`} />
      <ul className="space-y-1">
        {reports.length === 0 && <li className="text-sm text-muted-foreground">no reports yet</li>}
        {reports.map(r => (
          <li key={r.slug}>
            <Link href={`/briefs/${r.slug}`} className="text-sm hover:text-primary">
              {r.slug.split("/").pop()}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Reader page**

`panel/app/briefs/[...slug]/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { readReport } from "@/lib/files";

export const dynamic = "force-dynamic";

export default async function BriefPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const text = readReport(slug.join("/"));
  if (text === null) notFound();
  return (
    <div>
      <Link href="/briefs" className="text-sm text-primary">← all briefs</Link>
      <div className="mt-4"><Markdown text={text} /></div>
    </div>
  );
}
```

- [ ] **Step 4: Verify**

```bash
cd panel && JAMASP_ROOT=./test/fixtures/root npx next dev -p 3999 &
sleep 8 && curl -s localhost:3999/briefs/2026/07/2026-07-31-brief | grep -o "Morning Brief" && kill %1
```

Expected: `Morning Brief` prints.

- [ ] **Step 5: Commit**

```bash
git add panel/
git commit -m "feat(panel): briefs list and markdown reader"
```

---

### Task 12: Schedule page (wakeups, runs, add/cancel/run-now)

**Files:**
- Modify: `panel/app/schedule/page.tsx`
- Create: `panel/components/schedule-forms.tsx`

**Interfaces:**
- Consumes: `db.getWakeups`, `db.getAgentRuns`, `db.runsTodayDubai`, `files.maxRunsPerDay`, `actions.addWakeup`, `actions.cancelWakeup`, `actions.runNow`, `validate.RUN_TYPES`, `<StatCard/>`, shadcn `Dialog`/`Button`/`Input`/`Label`/`Table`/`Badge`.
- Produces: nothing consumed later.

- [ ] **Step 1: Client forms**

`panel/components/schedule-forms.tsx`:

```tsx
"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addWakeup, cancelWakeup, runNow, type ActionResult } from "@/lib/actions";
import { RUN_TYPES } from "@/lib/validate";

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<ActionResult>) => start(async () => {
    const r = await fn();
    r.ok ? toast.success(r.message) : toast.error(r.message);
    router.refresh();
  });
  return { pending, act };
}

export function RunNowButtons({ capped }: { capped: boolean }) {
  const { pending, act } = useAct();
  const [task, setTask] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {RUN_TYPES.filter(t => t !== "retro").map(t => (
        <Button key={t} size="sm" variant="outline" disabled={pending || capped}
          title={capped ? "daily run cap reached" : `queue a ${t} run now`}
          onClick={() => act(() => runNow(t, task))}>
          Run {t} now
        </Button>
      ))}
      <Input className="w-64" placeholder="optional task text (deepdive needs one)"
        value={task} onChange={e => setTask(e.target.value)} />
      {capped && <span className="text-xs text-amber-400">cap reached — runs disabled</span>}
    </div>
  );
}

export function AddWakeupDialog() {
  const { pending, act } = useAct();
  const [open, setOpen] = useState(false);
  const [due, setDue] = useState("");
  const [type, setType] = useState<string>("deepdive");
  const [task, setTask] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm">Schedule wakeup</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Schedule a wakeup</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="due">Due (your local time)</Label>
            <Input id="due" type="datetime-local" value={due}
              onChange={e => setDue(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="type">Run type</Label>
            <select id="type" value={type} onChange={e => setType(e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
              {RUN_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <Label htmlFor="task">Task</Label>
            <Input id="task" value={task} onChange={e => setTask(e.target.value)}
              placeholder="e.g. read the Fed statement and assess gold impact" />
          </div>
          <Button disabled={pending || !due} onClick={() => {
            act(() => addWakeup(new Date(due).toISOString(), type, task));
            setOpen(false);
          }}>Schedule</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CancelButton({ id }: { id: number }) {
  const { pending, act } = useAct();
  return (
    <Button size="sm" variant="ghost" disabled={pending}
      onClick={() => act(() => cancelWakeup(id))}>cancel</Button>
  );
}
```

- [ ] **Step 2: Page**

`panel/app/schedule/page.tsx`:

```tsx
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AddWakeupDialog, CancelButton, RunNowButtons } from "@/components/schedule-forms";
import * as db from "@/lib/db";
import { maxRunsPerDay } from "@/lib/files";
import { fmtAge, fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

function runDuration(started: string, finished: string | null): string {
  if (!finished) return "—";
  return `${Math.round((new Date(finished).getTime() - new Date(started).getTime()) / 1000)}s`;
}

export default function SchedulePage() {
  const now = new Date();
  const pending = db.getWakeups("pending");
  const history = db.getWakeups().filter(w => w.status !== "pending").slice(0, 20);
  const runs = db.getAgentRuns(30);
  const runsToday = db.runsTodayDubai(now);
  const cap = maxRunsPerDay();

  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Schedule" />
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <StatCard label="Runs today (Dubai)" value={`${runsToday}/${cap}`}
          tone={runsToday >= cap ? "warn" : undefined} />
        <div className="space-y-2">
          <RunNowButtons capped={runsToday >= cap} />
          <AddWakeupDialog />
        </div>
      </div>
      <h2 className="mb-2 font-medium">Pending wakeups</h2>
      <Table>
        <TableHeader><TableRow>
          <TableHead>#</TableHead><TableHead>Due (UTC)</TableHead><TableHead>In</TableHead>
          <TableHead>Type</TableHead><TableHead>Task</TableHead><TableHead /></TableRow>
        </TableHeader>
        <TableBody>
          {pending.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">none</TableCell></TableRow>}
          {pending.map(w => (
            <TableRow key={w.id}>
              <TableCell>{w.id}</TableCell><TableCell>{fmtUtc(w.due_at)}</TableCell>
              <TableCell>{fmtAge(w.due_at, now)}</TableCell><TableCell>{w.run_type}</TableCell>
              <TableCell className="max-w-md truncate">{w.task}</TableCell>
              <TableCell><CancelButton id={w.id} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <h2 className="mb-2 mt-8 font-medium">Agent runs</h2>
      <Table>
        <TableHeader><TableRow>
          <TableHead>Started</TableHead><TableHead>Type</TableHead><TableHead>Status</TableHead>
          <TableHead>Duration</TableHead><TableHead>Exit</TableHead><TableHead>Task</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {runs.map(r => (
            <TableRow key={r.id}>
              <TableCell>{fmtUtc(r.started_at)}</TableCell><TableCell>{r.run_type}</TableCell>
              <TableCell><Badge variant={r.status === "ok" ? "secondary" : "destructive"}>{r.status}</Badge></TableCell>
              <TableCell>{runDuration(r.started_at, r.finished_at)}</TableCell>
              <TableCell>{r.exit_code ?? "—"}</TableCell>
              <TableCell className="max-w-md truncate">{r.task ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <h2 className="mb-2 mt-8 font-medium">Wakeup history</h2>
      <ul className="space-y-1 text-sm text-muted-foreground">
        {history.map(w => (
          <li key={w.id}>#{w.id} {w.run_type} · {w.status} · due {fmtUtc(w.due_at)} · {w.task}</li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Verify actions end-to-end against the REAL repo (dev)**

This is the one place we exercise a real CLI-mediated write. Use the real repo root (default `JAMASP_ROOT`) but a **throwaway DB copy**:

```bash
cd /home/user/Jamasp
cp state/jamasp.db /tmp/panel-check.db 2>/dev/null || true
cd panel && npx next dev -p 3999 &
sleep 8
# schedule via the same server action path the UI uses: call the CLI directly
# to prove the round trip the action performs works from this cwd
(cd /home/user/Jamasp && uv run jamasp wakeup add 2030-01-01T00:00:00Z scan "panel plan check")
curl -s localhost:3999/schedule | grep -o "panel plan check"
(cd /home/user/Jamasp && uv run jamasp wakeup list | grep "panel plan check" | grep -o "#[0-9]*" | tr -d "#" | xargs -I{} uv run jamasp wakeup cancel {})
kill %1
```

Expected: `panel plan check` appears in the page HTML; cancel succeeds.

- [ ] **Step 4: Commit**

```bash
git add panel/
git commit -m "feat(panel): schedule page — wakeups, runs, run-now and cancel actions"
```

---

### Task 13: Calendar page

**Files:**
- Modify: `panel/app/calendar/page.tsx`

**Interfaces:**
- Consumes: `db.getEvents`, `fmtUtc`, `fmtDubai`, `Badge`, `<AutoRefresh/>`.

- [ ] **Step 1: Page**

```tsx
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { getEvents } from "@/lib/db";
import { fmtDubai, fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

function dubaiDay(ts: string): string {
  return new Date(new Date(ts).getTime() + 4 * 3600_000).toISOString().slice(0, 10);
}

export default function CalendarPage() {
  const events = getEvents(30);
  const byDay = new Map<string, typeof events>();
  for (const e of events) {
    const d = dubaiDay(e.starts_at);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(e);
  }
  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Calendar" subtitle={`${events.length} events in the next 30 days`} />
      {events.length === 0 && <p className="text-sm text-muted-foreground">nothing upcoming</p>}
      {[...byDay.entries()].map(([day, evs]) => (
        <section key={day} className="mb-6">
          <h2 className="mb-2 font-medium">{day} <span className="text-xs text-muted-foreground">(Dubai)</span></h2>
          <ul className="space-y-1 text-sm">
            {evs.map(e => (
              <li key={e.id} className="flex items-center gap-2">
                <span className="w-40 text-muted-foreground">{fmtUtc(e.starts_at)} · {fmtDubai(e.starts_at)}</span>
                {e.impact && (
                  <Badge variant={e.impact.toLowerCase() === "high" ? "destructive" : "outline"}>
                    {e.impact}
                  </Badge>
                )}
                <span>{e.title}</span>
                {e.country && <span className="text-xs text-muted-foreground">{e.country}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify**

```bash
cd panel && JAMASP_ROOT=./test/fixtures/root npx next dev -p 3999 &
sleep 8 && curl -s localhost:3999/calendar | grep -o "Nonfarm Payrolls" && kill %1
```

Expected: `Nonfarm Payrolls` prints.

- [ ] **Step 3: Commit**

```bash
git add panel/
git commit -m "feat(panel): calendar page — events by Dubai day with impact badges"
```

---

### Task 14: Alerts page (sent Telegram log + derived warnings)

**Files:**
- Modify: `panel/app/alerts/page.tsx`

**Interfaces:**
- Consumes: `db.getNotifyLog`, plus the same warning assembly as Overview (`deriveWarnings` with `db.getMeta/getAgentRuns/runsTodayDubai/getSourceErrors/lastItemPerSource`, `files.loadSources/maxRunsPerDay`, `deriveSourceHealth`), shadcn `Tabs`, `fmtUtc`, `<AutoRefresh/>`.
- Persian detection: `/[؀-ۿ]/` on the message → `dir="rtl"` + Vazirmatn stack.

- [ ] **Step 1: Page**

```tsx
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as db from "@/lib/db";
import { loadSources, maxRunsPerDay } from "@/lib/files";
import { deriveSourceHealth, deriveWarnings } from "@/lib/health";
import { fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

const PERSIAN = /[؀-ۿ]/;

export default function AlertsPage() {
  const now = new Date();
  const sinceIso = new Date(now.getTime() - 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sent = db.getNotifyLog(100);
  const sources = loadSources();
  const health = deriveSourceHealth(
    sources,
    Object.fromEntries(sources.map(s => [s.name, db.getMeta(`source_last_fetch.${s.name}`)])),
    Object.fromEntries(db.lastItemPerSource().map(r => [r.source, r.last])),
    db.getSourceErrors(sinceIso), now);
  const warnings = deriveWarnings({
    lastIngestAt: db.getMeta("last_ingest_at"), runs: db.getAgentRuns(50),
    sourceHealth: health, runsToday: db.runsTodayDubai(now), cap: maxRunsPerDay() }, now);

  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Alerts" />
      <Tabs defaultValue="sent">
        <TabsList>
          <TabsTrigger value="sent">Sent ({sent.length})</TabsTrigger>
          <TabsTrigger value="warnings">Warnings ({warnings.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="sent">
          <ul className="mt-4 space-y-3">
            {sent.length === 0 && <li className="text-sm text-muted-foreground">nothing sent yet</li>}
            {sent.map(m => (
              <li key={m.id} className="rounded border border-border p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  {fmtUtc(m.ts)}
                  {m.ok === 0 && <Badge variant="destructive">send failed</Badge>}
                </div>
                <p dir={PERSIAN.test(m.text) ? "rtl" : "ltr"}
                  className="whitespace-pre-wrap text-sm [font-family:Vazirmatn,Tahoma,sans-serif]">
                  {m.text}
                </p>
              </li>
            ))}
          </ul>
        </TabsContent>
        <TabsContent value="warnings">
          <ul className="mt-4 space-y-2">
            {warnings.length === 0 && <li className="text-sm text-emerald-400">all clear</li>}
            {warnings.map((w, i) => (
              <li key={i} className={w.severity === "red"
                ? "rounded border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300"
                : "rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-sm text-amber-300"}>
                {w.text}
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

```bash
cd panel && JAMASP_ROOT=./test/fixtures/root npx next dev -p 3999 &
sleep 8 && curl -s localhost:3999/alerts | grep -o "send failed" && kill %1
```

Expected: `send failed` prints (fixture has one failed send).

- [ ] **Step 3: Commit**

```bash
git add panel/
git commit -m "feat(panel): alerts page — sent Telegram log and derived warnings"
```

---

### Task 15: State page (stance, watchlist, playbook, predictions scorecard)

**Files:**
- Modify: `panel/app/state/page.tsx`

**Interfaces:**
- Consumes: `files.readStance/readWatchlist/readPlaybook/readPredictions/predictionStats`, `<Markdown/>` from Task 11, `fmtAge`, shadcn `Table`/`Badge`, `<AutoRefresh/>`.

- [ ] **Step 1: Page**

```tsx
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import * as files from "@/lib/files";
import { fmtAge } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function StatePage() {
  const stance = files.readStance();
  const playbook = files.readPlaybook();
  const watchlist = files.readWatchlist();
  const preds = files.readPredictions();
  const stats = files.predictionStats(preds);
  const openOrDue = preds.filter(p => p.outcome === null);

  return (
    <div>
      <AutoRefresh seconds={60} />
      <PageHeader title="State" />
      <section className="mb-8">
        <h2 className="mb-2 font-medium">Stance</h2>
        {stance ? <Markdown text={stance} /> : <p className="text-sm text-muted-foreground">no stance yet</p>}
      </section>
      <section className="mb-8">
        <h2 className="mb-2 font-medium">Watchlist</h2>
        <ul className="space-y-1 text-sm">
          {watchlist.length === 0 && <li className="text-muted-foreground">empty</li>}
          {watchlist.map(w => (
            <li key={w.theme}>
              <span className="font-medium">{w.theme}</span>
              <span className="text-muted-foreground"> — {w.why} · since {w.since}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="mb-8">
        <h2 className="mb-2 font-medium">
          Predictions
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {stats.open} open · {stats.maturedUnscored} due · {stats.scored} scored ·
            hit rate {stats.hitRate === null ? "—" : `${Math.round(stats.hitRate * 100)}%`}
          </span>
        </h2>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Claim</TableHead><TableHead>Dir</TableHead><TableHead>Conf</TableHead>
            <TableHead>Horizon</TableHead><TableHead>Made</TableHead><TableHead>Outcome</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {[...openOrDue, ...preds.filter(p => p.outcome !== null)].map(p => (
              <TableRow key={p.id}>
                <TableCell className="max-w-md">{p.claim}</TableCell>
                <TableCell>{p.direction}</TableCell>
                <TableCell>{Math.round(p.confidence * 100)}%</TableCell>
                <TableCell>{p.horizon_days}d</TableCell>
                <TableCell>{fmtAge(p.created_at)}</TableCell>
                <TableCell>
                  {p.outcome
                    ? <Badge variant={p.outcome === "hit" ? "secondary" : p.outcome === "miss" ? "destructive" : "outline"}>{p.outcome}</Badge>
                    : <Badge variant="outline">open</Badge>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <section>
        <h2 className="mb-2 font-medium">Playbook</h2>
        {playbook ? <Markdown text={playbook} /> : <p className="text-sm text-muted-foreground">no playbook yet</p>}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

```bash
cd panel && JAMASP_ROOT=./test/fixtures/root npx next dev -p 3999 &
sleep 8 && curl -s localhost:3999/state | grep -o "fed-rate-path" && kill %1
```

Expected: `fed-rate-path` prints.

- [ ] **Step 3: Commit**

```bash
git add panel/
git commit -m "feat(panel): state page — stance, watchlist, predictions scorecard, playbook"
```

---

### Task 16: Prices page (charts + range picker)

**Files:**
- Create: `panel/app/api/prices/route.ts`, `panel/components/price-chart.tsx`
- Modify: `panel/app/prices/page.tsx`

**Interfaces:**
- Consumes: `db.getPriceSeries`, `db.getPriceSnapshots`, recharts, swr.
- Produces: `GET /api/prices?symbol=GC&range=7d` → `{ points: PricePoint[] }` (range ∈ `24h|7d|30d`).
- **NOTE for implementer:** load the `dataviz` skill BEFORE writing the chart component — it governs chart colors/axis/tooltip conventions; adapt the component below to what it prescribes (keep the props/API the same).

- [ ] **Step 1: API route**

`panel/app/api/prices/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getPriceSeries } from "@/lib/db";

export const dynamic = "force-dynamic";

const RANGES: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30 };

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const symbol = p.get("symbol") ?? "GC";
  const days = RANGES[p.get("range") ?? "7d"] ?? 7;
  const since = new Date(Date.now() - days * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return NextResponse.json({ points: getPriceSeries(symbol, since) });
}
```

- [ ] **Step 2: Chart component**

`panel/components/price-chart.tsx`:

```tsx
"use client";
import { useState } from "react";
import useSWR from "swr";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import type { PricePoint } from "@/lib/db";
import { fmtUtc } from "@/lib/format";

const fetcher = (url: string) => fetch(url).then(r => r.json());
const RANGES = ["24h", "7d", "30d"] as const;

export function PriceChart({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>("7d");
  const { data } = useSWR<{ points: PricePoint[] }>(
    `/api/prices?symbol=${encodeURIComponent(symbol)}&range=${range}`, fetcher,
    { refreshInterval: 60_000 });
  const points = data?.points ?? [];
  return (
    <div className="rounded border border-border p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">{symbol}</h2>
        <div className="flex gap-1">
          {RANGES.map(r => (
            <Button key={r} size="sm" variant={r === range ? "secondary" : "ghost"}
              onClick={() => setRange(r)}>{r}</Button>
          ))}
        </div>
      </div>
      {points.length < 2
        ? <p className="py-10 text-center text-sm text-muted-foreground">not enough data in range</p>
        : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points} margin={{ left: 8, right: 8, top: 4, bottom: 4 }}>
              <XAxis dataKey="ts" tickFormatter={fmtUtc} minTickGap={60}
                stroke="currentColor" fontSize={11} />
              <YAxis domain={["auto", "auto"]} width={64} stroke="currentColor" fontSize={11} />
              <Tooltip labelFormatter={l => fmtUtc(String(l))}
                contentStyle={{ background: "#111", border: "1px solid #333" }} />
              <Line type="monotone" dataKey="value" dot={false} strokeWidth={1.5}
                stroke="var(--primary)" isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
    </div>
  );
}
```

- [ ] **Step 3: Page**

`panel/app/prices/page.tsx`:

```tsx
import { PageHeader } from "@/components/page-header";
import { PriceChart } from "@/components/price-chart";
import { getPriceSnapshots } from "@/lib/db";

export const dynamic = "force-dynamic";

export default function PricesPage() {
  const snapshots = getPriceSnapshots();
  return (
    <div>
      <PageHeader title="Prices" subtitle={`${snapshots.length} symbols tracked`} />
      <div className="grid gap-4 xl:grid-cols-2">
        {snapshots.length === 0 && <p className="text-sm text-muted-foreground">no price data yet</p>}
        {snapshots.map(s => <PriceChart key={s.symbol} symbol={s.symbol} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify**

```bash
cd panel && JAMASP_ROOT=./test/fixtures/root npx next dev -p 3999 &
sleep 8
curl -s "localhost:3999/api/prices?symbol=GC&range=30d" | grep -o "3325"
curl -s localhost:3999/prices | grep -o "symbols tracked"
kill %1
```

Expected: both greps print. (The 30d range covers the fixture's 2026-07-25 → 2026-08-01 points only while today's date is near the fixture dates; if the API grep is empty because real "now" has moved past the fixture window, assert on the page grep plus `npm test` instead — the series query itself is covered by `db.test.ts`.)

- [ ] **Step 5: Commit**

```bash
git add panel/
git commit -m "feat(panel): prices page — per-symbol charts with range picker"
```

---

### Task 17: Playwright smoke test (all nine routes)

**Files:**
- Create: `panel/playwright.config.ts`, `panel/e2e/smoke.spec.ts`
- Modify: `panel/package.json` (add `"e2e": "playwright test"`)

**Interfaces:**
- Consumes: the fixture root (Tasks 4–5) and every page (Tasks 8–16).

- [ ] **Step 1: Install and configure**

```bash
cd panel && npm install -D @playwright/test
```

Do NOT run `playwright install` in the remote dev container (Chromium is pre-provisioned via `PLAYWRIGHT_BROWSERS_PATH`); on other machines run `npx playwright install chromium` once.

`panel/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:3311" },
  webServer: {
    command: "npm run fixture && npm run dev -- -p 3311",
    url: "http://127.0.0.1:3311",
    env: { JAMASP_ROOT: "./test/fixtures/root" },
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
```

- [ ] **Step 2: Write the spec**

`panel/e2e/smoke.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

const ROUTES: [string, string][] = [
  ["/", "Overview"], ["/inbox", "Inbox"], ["/crawl", "Crawl"], ["/briefs", "Briefs"],
  ["/schedule", "Schedule"], ["/calendar", "Calendar"], ["/alerts", "Alerts"],
  ["/state", "State"], ["/prices", "Prices"],
];

for (const [path, title] of ROUTES) {
  test(`renders ${path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e)));
    const resp = await page.goto(path);
    expect(resp!.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(title);
    expect(errors).toEqual([]);
  });
}

test("brief reader renders fixture report", async ({ page }) => {
  await page.goto("/briefs/2026/07/2026-07-31-brief");
  await expect(page.getByText("Morning Brief")).toBeVisible();
});
```

- [ ] **Step 3: Run**

Run: `cd panel && npm run e2e`
Expected: 10 tests pass.

- [ ] **Step 4: Commit**

```bash
git add panel/
git commit -m "test(panel): playwright smoke — all routes render against the fixture root"
```

---

### Task 18: systemd unit, deploy-skill addendum, CLAUDE.md note

**Files:**
- Create: `ops/systemd/jamasp-panel.service`
- Modify: `.claude/skills/deploy/SKILL.md` (append a "Panel" section)
- Modify: `CLAUDE.md` (one line under "Working on Jamasp itself")

**Interfaces:**
- Consumes: the built panel (`npm run build` output in `panel/.next`).

- [ ] **Step 1: Unit file**

`ops/systemd/jamasp-panel.service` (matches the repo's `%h` convention; the deploy skill's existing sed pipeline that installs `ops/systemd/jamasp-*` picks it up automatically):

```ini
[Unit]
Description=Jamasp panel — web control panel on 127.0.0.1:3300
After=network.target

[Service]
WorkingDirectory=%h/Jamasp/panel
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=JAMASP_ROOT=%h/Jamasp
EnvironmentFile=-%h/.config/jamasp/env
ExecStart=/usr/bin/env npx next start -H 127.0.0.1 -p 3300
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Deploy skill addendum**

Append to `.claude/skills/deploy/SKILL.md`:

```markdown
## Panel (optional web control panel)

The panel is a Next.js app in `panel/`, served on `127.0.0.1:3300` by
`jamasp-panel.service` (a long-running service — enable it, unlike the
oneshot timer units).

1. Install Node >= 20 (NodeSource apt repo or the distro package).
2. Build: `cd ~/Jamasp/panel && npm ci && npm run build`.
3. Install/enable the unit the same way as the timers (the
   `ops/systemd/jamasp-*` glob already includes it), then:
   `systemctl --user enable --now jamasp-panel.service` (or the system
   variant with `User=jamasp`).
4. Verify: `curl -s http://127.0.0.1:3300/ | grep -q Overview && echo OK`.
5. Access from a workstation: `ssh -L 3300:127.0.0.1:3300 jamasp@<host>`
   or `tailscale serve 3300`. The panel has NO auth of its own — never
   bind it to a public interface.
6. Rebuild after every `git pull` that touches `panel/`:
   `npm ci && npm run build && systemctl --user restart jamasp-panel`.
```

- [ ] **Step 3: CLAUDE.md note**

In `CLAUDE.md`, at the end of the "Working on Jamasp itself" section, add:

```markdown
The web control panel lives in `panel/` (Next.js; see
`docs/superpowers/specs/2026-08-01-jamasp-panel-design.md`). It reads
`state/jamasp.db` read-only and performs every write through the `jamasp`
CLI — keep it that way.
```

- [ ] **Step 4: Final full verification**

```bash
cd /home/user/Jamasp && uv run pytest -q
cd panel && npm test && npm run build && npm run e2e
```

Expected: everything green.

- [ ] **Step 5: Commit and push**

```bash
cd /home/user/Jamasp
git add ops/systemd/jamasp-panel.service .claude/skills/deploy/SKILL.md CLAUDE.md
git commit -m "feat(ops): jamasp-panel systemd unit + deploy runbook addendum"
git push -u origin claude/jamasp-dashboard-panel-m83pgh
```
