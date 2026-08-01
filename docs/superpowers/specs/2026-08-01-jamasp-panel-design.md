# Jamasp Panel — Design Spec

**Date:** 2026-08-01
**Status:** Approved (brainstorming session with Saman)

## Purpose

A web control panel for Jamasp, served from the same always-on Linux host,
giving the desk a full view of the agent — inbox, crawl health, briefs,
schedules, calendar, alerts, analyst state, predictions, prices — plus safe
actions: mark inbox read, add/cancel wakeups, and trigger agent runs.

## Decisions made

| Question | Decision |
|---|---|
| Panel role | Full control panel (reads + actions + run triggering) |
| Deployment | Same host as Jamasp, bound to localhost, reached over private network (Tailscale/SSH tunnel); no in-app auth |
| Alerts meaning | Sent-Telegram log (new `notify_log` table) + derived health warnings |
| Extra sections | Analyst state (stance/watchlist/playbook), predictions scorecard, prices dashboard |
| Architecture | Single Next.js app; direct read-only SQLite reads; **all writes via the jamasp CLI** |

## Architecture

- New `panel/` directory at repo root: Next.js (App Router, TypeScript),
  Tailwind CSS, shadcn/ui. Dark-mode default, gold accent.
- **Reads:** route handlers / server components open `state/jamasp.db` with
  `better-sqlite3` in read-only mode, and read `state/stance.md`,
  `state/watchlist.yaml`, `state/playbook.md`, `state/predictions.jsonl`,
  `reports/**/*.md` from disk. UI polls with SWR (~30 s). No websockets.
- **Writes:** every mutation shells out to the CLI
  (`uv run jamasp ...`, cwd = repo root). Python stays the only DB writer:
  - mark inbox read → `jamasp inbox --mark-read`
  - schedule / trigger run → `jamasp wakeup add "<ISO>" <type> "<task>"`;
    "Run now" = wakeup due now, fired by the 5-minute dispatcher, so the
    daily run cap, retry, and per-type timeouts apply unchanged
  - cancel wakeup → new `jamasp wakeup cancel <id>` subcommand
- **Deployment:** new systemd unit `jamasp-panel.service` running
  `next start` on `127.0.0.1:3300`. Deploy skill gets an addendum.

## Jamasp (Python) changes

1. `notify.py` writes every sent Telegram message to a new `notify_log`
   table (`ts`, `text`, `ok`) in `state/jamasp.db`.
2. New CLI subcommand `jamasp wakeup cancel <id>` — sets a pending wakeup's
   status to `cancelled`.
3. (Deferred) a dispatch-now shortcut if the ≤5-minute trigger latency
   proves annoying.

## Pages

- **`/` Overview** — health strip (last ingest age, last run per type,
  runs-today vs cap, source-error count 24 h), price snapshot cards with
  deltas (GC=F, DXY, real yield), unread count, next 3 wakeups, next 3
  calendar events, latest alert. Everything links into its section.
- **`/inbox`** — items table, unread first, grouped by `cluster_id`;
  filters: source, topic, read state; headline links to article;
  "Mark delta read" button.
- **`/crawl`** — per-source health derived from `items` (last item per
  source vs its configured interval in `config/sources.yaml`) plus the
  `source_errors` log. Stale/erroring sources sort to top, red/amber badges.
- **`/briefs`** — tree of `reports/YYYY/MM/*.md`, rendered with
  react-markdown, newest first.
- **`/schedule`** — pending wakeups (cancel button), fired/expired history,
  `agent_runs` table (type, status, duration, exit code), cap gauge;
  "Schedule wakeup" dialog (ISO time, run type, task); "Run now" buttons
  for scan/brief/deepdive.
- **`/calendar`** — upcoming `events` grouped by day, dual UTC/Dubai times,
  impact badges (high = red, medium = amber).
- **`/alerts`** — tabs: *Sent* (`notify_log`, Persian rendered RTL) and
  *Warnings* (derived: stale ingest, failed/timed-out/deferred runs,
  repeatedly erroring sources).
- **`/state`** — stance.md rendered, watchlist with `since` ages,
  playbook.md, predictions scorecard (open forecasts, matured-unscored,
  hit-rate over scored).
- **`/prices`** — recharts line charts per symbol from `prices` table,
  range picker 24 h / 7 d / 30 d.

Persian content renders `dir="rtl"` with a Persian-capable font; numbers
and tickers stay Latin (house style).

## Data flow

- `lib/db.ts` — read-only better-sqlite3 handle + typed query functions.
- `lib/files.ts` — stance/watchlist/playbook/predictions/reports readers.
- `lib/actions.ts` — server actions wrapping `execFile` of the CLI,
  returning `{ok, stdout, stderr}`.
- Pages are server components; interactive tables are client components
  fed by `/api/*` route handlers, polled with SWR. No global state store.

## Error handling

- DB busy: one retry per query; on failure render an inline "db busy"
  note, never a 500.
- CLI action failure: server action returns stderr verbatim; UI shows a
  destructive toast. No automatic retries of mutations.
- Missing/partial files (fresh host): readers return explicit empty
  states; pages render "nothing yet" placeholders.
- Guardrails: "Run now" disabled with tooltip when runs-today ≥ cap;
  wakeup form validates ISO datetime and known run types on both client
  and server.

## Testing

- Python additions: pytest in existing `tests/`, TDD per house skills.
- Panel: vitest for `lib/` (query shaping, staleness derivation,
  hit-rate math) against a fixture SQLite DB in `panel/test/fixtures/`.
- One Playwright smoke test: app boots against the fixture DB; all nine
  routes render without error.

## Out of scope (v1)

- Live run-output tailing (runner discards output by design — see
  `runner.py` `_execute_once`).
- Browser push notifications / sounds.
- In-app authentication (network is the boundary).
- Editing stance/watchlist/playbook from the browser.
- Mobile-optimized layouts (desktop target; should degrade acceptably).
