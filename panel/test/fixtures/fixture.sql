CREATE TABLE IF NOT EXISTS items (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    published_at TEXT NOT NULL,
    headline     TEXT NOT NULL,
    lede         TEXT,
    url          TEXT NOT NULL,
    topic        TEXT NOT NULL,
    cluster_id   TEXT,
    fetched_at   TEXT NOT NULL,
    read_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_read ON items(read_at);
CREATE TABLE IF NOT EXISTS prices (
    symbol TEXT NOT NULL,
    ts     TEXT NOT NULL,
    value  REAL NOT NULL,
    PRIMARY KEY (symbol, ts)
);
CREATE TABLE IF NOT EXISTS extract_cache (
    url        TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    text       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_errors (
    source TEXT NOT NULL,
    ts     TEXT NOT NULL,
    error  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wakeups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    due_at     TEXT NOT NULL,
    run_type   TEXT NOT NULL,
    task       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    fired_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_wakeups_status_due ON wakeups(status, due_at);
CREATE TABLE IF NOT EXISTS events (
    id         TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    title      TEXT NOT NULL,
    country    TEXT,
    impact     TEXT,
    starts_at  TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
CREATE TABLE IF NOT EXISTS agent_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type    TEXT NOT NULL,
    task        TEXT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    exit_code   INTEGER,
    status      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notify_log (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   TEXT NOT NULL,
    text TEXT NOT NULL,
    ok   INTEGER NOT NULL
);

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
 ('scan',NULL,'2026-08-01T07:00:00Z','2026-08-01T07:02:00Z',1,'failed'),
 ('deepdive',NULL,'2026-08-01T06:00:00Z',NULL,NULL,'deferred');
INSERT INTO meta VALUES ('last_ingest_at','2026-08-01T08:05:00Z'),
 ('source_last_fetch.cnbc_finance','2026-08-01T08:05:00Z');
INSERT INTO notify_log (ts,text,ok) VALUES
 ('2026-08-01T05:10:00Z','خلاصه صبحگاهی: طلا در محدوده 3325 معامله می‌شود',1),
 ('2026-08-01T07:03:00Z','Jamasp FAILURE: scan run failed after retry, exit=1.',0);
