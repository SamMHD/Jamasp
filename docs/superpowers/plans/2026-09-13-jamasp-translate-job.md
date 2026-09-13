# `jamasp translate` Job Implementation Plan (PR 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `jamasp translate` job — Persian renderings of every row and document the panel will render — and the timer that runs it, with the panel itself untouched.

**Architecture:** Four passes behind one CLI command. A free SQL pass copies Persian the flash pipeline already wrote; two model passes translate remaining `items` and `events` rows in batches of 20 into `_fa` columns; a fourth pass writes `.fa` sidecar files for agent-written documents, keyed by a hash of their English source. Pure text handling (prompts, parsing, sidecar formats) lives in `translatetext.py` with no I/O, mirroring the existing `flashtext.py` split; the subprocess runner lives in `modelrun.py` so its two protocols are testable in isolation.

**Tech Stack:** Python 3.12, click, SQLite (stdlib `sqlite3`), PyYAML, pytest, `uv`. Model calls shell out to `codex exec` with `--output-schema`; no Python SDK.

**Spec:** `docs/superpowers/specs/2026-09-13-panel-i18n-translate-design.md`

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **This PR does not touch `panel/`.** The panel ships in PR 2. A change under `panel/` in this PR is out of scope.
- **Never write into a file the agent owns.** `state/stance.md`, `state/watchlist.yaml`, `state/predictions.jsonl` and `state/playbook.md` are rewritten by agent runs. All translations go to separate `.fa` sidecar files.
- **Latin digits, tickers and symbols pass through unchanged.** Prompts instruct it; nothing post-processes numerals.
- **Acronyms and tickers stay Latin** (`FOMC`, `DXY`, `XAU`, `CPI` as glossed). Institution and concept names take the glossary's Persian.
- **No test calls a live model.** `translate.cmd` points at `tests/fake_codex.py` in every test.
- **The job consumes no agent-run budget.** It is a deterministic pipeline stage like flash — never wrapped by `jamasp run`.
- **Schema changes go through `ADDED_COLUMNS`** in `jamasp/db.py`, never through editing `SCHEMA`. The live database is months of history that cannot be recreated.
- **`ALTER TABLE ADD COLUMN` requires a default for `NOT NULL`.** `fa_attempts` is declared `INTEGER NOT NULL DEFAULT 0`; the other added columns are nullable.
- **Run tests with** `uv run pytest`.
- **Commit style:** `<type>(<scope>): <subject>`, imperative, lowercase subject.

---

### Task 1: Schema columns and the glossary file

**Files:**
- Modify: `jamasp/db.py:204-212` (the `ADDED_COLUMNS` tuple)
- Modify: `jamasp/config.py` (add `load_glossary` after `load_weights`)
- Create: `config/glossary.fa.yaml`
- Test: `tests/test_db.py`, `tests/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `items.headline_fa`, `items.lede_fa`, `items.fa_source`, `items.fa_at`, `items.fa_attempts`, `items.fa_error`; `events.title_fa`, `events.fa_at`, `events.fa_attempts`, `events.fa_error`. Function `config.load_glossary(path: Path = Path("config/glossary.fa.yaml")) -> dict[str, str]`.

- [ ] **Step 1: Write the failing test for the added columns**

Add to `tests/test_db.py`:

```python
def test_translation_columns_added_to_existing_database(tmp_path):
    """A database created before this feature gains the columns on connect."""
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE items (id TEXT PRIMARY KEY, source TEXT NOT NULL,"
        " published_at TEXT NOT NULL, headline TEXT NOT NULL, lede TEXT,"
        " url TEXT NOT NULL, topic TEXT NOT NULL, cluster_id TEXT,"
        " fetched_at TEXT NOT NULL, read_at TEXT);"
        "CREATE TABLE events (id TEXT PRIMARY KEY, source TEXT NOT NULL,"
        " title TEXT NOT NULL, country TEXT, impact TEXT,"
        " starts_at TEXT NOT NULL, fetched_at TEXT NOT NULL);"
    )
    conn.commit()
    conn.close()

    conn = db.connect(path)
    items = {r[1] for r in conn.execute("PRAGMA table_info(items)")}
    events = {r[1] for r in conn.execute("PRAGMA table_info(events)")}
    assert {"headline_fa", "lede_fa", "fa_source", "fa_at",
            "fa_attempts", "fa_error"} <= items
    assert {"title_fa", "fa_at", "fa_attempts", "fa_error"} <= events


def test_fa_attempts_defaults_to_zero(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    conn.execute(
        "INSERT INTO items (id, source, published_at, headline, url, topic,"
        " fetched_at) VALUES ('i1','a','2026-09-13T00:00:00Z','H',"
        " 'https://e/1','gold','2026-09-13T00:00:00Z')"
    )
    row = conn.execute("SELECT fa_attempts, headline_fa FROM items").fetchone()
    assert row["fa_attempts"] == 0
    assert row["headline_fa"] is None
```

`tests/test_db.py` already imports `sqlite3` and `db`; confirm before adding.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_db.py -k translation_columns -v`
Expected: FAIL — the assertion on the `items` column set fails because `headline_fa` is absent.

- [ ] **Step 3: Add the columns**

In `jamasp/db.py`, extend `ADDED_COLUMNS`:

```python
    # Panel i18n. Filled by `jamasp translate`; read by the panel from PR 2.
    # fa_source distinguishes Persian copied from a flash (editorial, written
    # for the news channel) from Persian a model translated (faithful to the
    # headline). An audit that cannot tell them apart cannot act on a report
    # that the channel and the panel read differently.
    ("items", "headline_fa", "TEXT"),
    ("items", "lede_fa", "TEXT"),
    ("items", "fa_source", "TEXT"),
    ("items", "fa_at", "TEXT"),
    ("items", "fa_attempts", "INTEGER NOT NULL DEFAULT 0"),
    ("items", "fa_error", "TEXT"),
    ("events", "title_fa", "TEXT"),
    ("events", "fa_at", "TEXT"),
    ("events", "fa_attempts", "INTEGER NOT NULL DEFAULT 0"),
    ("events", "fa_error", "TEXT"),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_db.py -v`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Write the failing test for the glossary loader**

Add to `tests/test_config.py`:

```python
def test_load_glossary_returns_term_map(tmp_path):
    path = tmp_path / "glossary.fa.yaml"
    path.write_text("Fed: فدرال رزرو\nDXY: DXY\n", encoding="utf-8")
    assert config.load_glossary(path) == {"Fed": "فدرال رزرو", "DXY": "DXY"}


def test_load_glossary_of_real_file_keeps_tickers_latin():
    """The shipped glossary must not translate tickers or bare acronyms."""
    g = config.load_glossary()
    assert g["DXY"] == "DXY"
    assert g["XAU"] == "XAU"
    assert g["FOMC"] == "FOMC"
    assert g["Fed"] != "Fed"
```

- [ ] **Step 6: Run it to verify it fails**

Run: `uv run pytest tests/test_config.py -k glossary -v`
Expected: FAIL with `AttributeError: module 'jamasp.config' has no attribute 'load_glossary'`.

- [ ] **Step 7: Write the glossary file**

Create `config/glossary.fa.yaml`:

```yaml
# Pinned Persian for recurring market terms.
#
# Injected into every `jamasp translate` prompt AND into the flash pipeline's
# write/rollup prompts, so the panel and the Telegram news channel cannot drift
# apart on terminology. Tickers and bare acronyms stay Latin deliberately: a
# gold desk reads DXY as DXY, and a transliteration is a readability
# regression, not a localization win.
#
# Editing this file does not retranslate anything. `jamasp translate --force`
# does.
Fed: فدرال رزرو
Federal Reserve: فدرال رزرو
FOMC: FOMC
CPI: شاخص قیمت مصرف‌کننده (CPI)
PPI: شاخص قیمت تولیدکننده (PPI)
PCE: PCE
NFP: NFP
DXY: DXY
XAU: XAU
Treasury yield: بازده اوراق خزانه
real yield: بازده واقعی
safe haven: دارایی امن
hawkish: انقباضی
dovish: انبساطی
rate cut: کاهش نرخ بهره
rate hike: افزایش نرخ بهره
inflation: تورم
central bank: بانک مرکزی
ETF: ETF
bullion: شمش
spot gold: طلای نقدی
gold futures: قراردادهای آتی طلا
```

- [ ] **Step 8: Add the loader**

In `jamasp/config.py`, after `load_weights`:

```python
def load_glossary(path: Path = Path("config/glossary.fa.yaml")) -> dict[str, str]:
    """Pinned Persian for recurring market terms, term -> rendering.

    Shared by `jamasp translate` and the flash pipeline's prompts: one file is
    what keeps the panel and the news channel from settling on two different
    Persian words for the same thing.
    """
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `uv run pytest tests/test_config.py tests/test_db.py -v`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add jamasp/db.py jamasp/config.py config/glossary.fa.yaml tests/test_db.py tests/test_config.py
git commit -m "feat(translate): add _fa columns and the pinned glossary"
```

---

### Task 2: Prompt building and response parsing

**Files:**
- Create: `jamasp/translatetext.py`
- Test: `tests/test_translatetext.py`

**Interfaces:**
- Consumes: `config.load_glossary` (Task 1) for the shape of the glossary dict.
- Produces:
  - `glossary_block(glossary: dict[str, str]) -> str`
  - `build_rows_prompt(rows: Sequence[Mapping], fields: Sequence[str], glossary: dict[str, str]) -> str`
  - `rows_schema(fields: Sequence[str]) -> dict`
  - `parse_rows_response(payload: object, count: int, fields: Sequence[str]) -> dict[int, dict[str, str]]`
  - `ParseError` (subclass of `ValueError`)

This module is pure: no database, no network, no subprocess — same contract as `jamasp/flashtext.py`, and the reason its tests are fast and total.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_translatetext.py`:

```python
import pytest

from jamasp import translatetext as tt

GLOSSARY = {"Fed": "فدرال رزرو", "DXY": "DXY"}
ROWS = [
    {"id": "a1", "headline": "Gold climbs as dollar slips", "lede": "Bullion rose."},
    {"id": "b2", "headline": "Fed holds rates steady", "lede": None},
]


def test_glossary_block_lists_every_term():
    block = tt.glossary_block(GLOSSARY)
    assert "Fed → فدرال رزرو" in block
    assert "DXY → DXY" in block


def test_prompt_numbers_rows_from_one_and_omits_ids():
    prompt = tt.build_rows_prompt(ROWS, ("headline", "lede"), GLOSSARY)
    assert "[1]" in prompt and "[2]" in prompt
    assert "Gold climbs as dollar slips" in prompt
    # ids are long and a model that mangles one costs a row; indices map back.
    assert "a1" not in prompt


def test_prompt_carries_the_standing_rules():
    prompt = tt.build_rows_prompt(ROWS, ("headline",), GLOSSARY)
    for rule in ("Latin", "faithful", "already Persian"):
        assert rule.lower() in prompt.lower()


def test_schema_requires_each_field_except_optional_lede():
    schema = tt.rows_schema(("headline", "lede"))
    props = schema["additionalProperties"]["properties"]
    assert set(props) == {"headline", "lede"}
    assert schema["additionalProperties"]["required"] == ["headline"]


def test_parse_maps_indices_back_to_zero_based_positions():
    out = tt.parse_rows_response(
        {"1": {"headline": "طلا بالا رفت"}, "2": {"headline": "فدرال رزرو"}},
        count=2, fields=("headline",),
    )
    assert out == {0: {"headline": "طلا بالا رفت"}, 1: {"headline": "فدرال رزرو"}}


def test_parse_accepts_a_json_string_as_well_as_an_object():
    out = tt.parse_rows_response('{"1": {"headline": "ط"}}', 1, ("headline",))
    assert out[0]["headline"] == "ط"


def test_parse_drops_out_of_range_and_unparsable_indices():
    out = tt.parse_rows_response(
        {"1": {"headline": "ok"}, "9": {"headline": "x"}, "n": {"headline": "y"}},
        count=1, fields=("headline",),
    )
    assert out == {0: {"headline": "ok"}}


def test_parse_skips_entries_missing_the_required_field():
    out = tt.parse_rows_response(
        {"1": {"lede": "only a lede"}, "2": {"headline": "fine"}},
        count=2, fields=("headline", "lede"),
    )
    assert out == {1: {"headline": "fine"}}


def test_parse_keeps_an_absent_optional_field_absent():
    out = tt.parse_rows_response({"1": {"headline": "h"}}, 1, ("headline", "lede"))
    assert "lede" not in out[0]


def test_parse_rejects_non_json():
    with pytest.raises(tt.ParseError):
        tt.parse_rows_response("not json at all", 1, ("headline",))


def test_parse_rejects_a_json_array():
    with pytest.raises(tt.ParseError):
        tt.parse_rows_response("[1, 2, 3]", 1, ("headline",))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_translatetext.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.translatetext'`.

- [ ] **Step 3: Write the module**

Create `jamasp/translatetext.py`:

```python
"""Pure text for the translate job: prompts, schemas, response parsing.

Nothing here touches the database, the network, or a subprocess, so every
function is directly testable — the same split as jamasp/flashtext.py.
"""
from __future__ import annotations

import json
from typing import Mapping, Sequence


class ParseError(ValueError):
    """The model returned something that is not a usable response object."""


RULES = (
    "Translate each numbered entry into Persian (Farsi).\n"
    "- Translate faithfully. Do not editorialize, summarise, or add context.\n"
    "- Keep Latin digits, tickers, symbols, currencies and percentages exactly"
    " as they appear: 2,650.40 stays 2,650.40 and GC=F stays GC=F.\n"
    "- Apply the glossary below for every term it covers.\n"
    "- If an entry is already Persian, return it unchanged.\n"
    "- Return a JSON object keyed by the entry number as a string."
)


def glossary_block(glossary: Mapping[str, str]) -> str:
    """The glossary rendered for a prompt, one `term → rendering` per line."""
    lines = "\n".join(f"{k} → {v}" for k, v in glossary.items())
    return f"Glossary (authoritative):\n{lines}"


def build_rows_prompt(
    rows: Sequence[Mapping], fields: Sequence[str], glossary: Mapping[str, str]
) -> str:
    """One batch prompt. Entries are numbered from 1; ids never appear.

    Indices rather than ids because ids are 16 hex characters, and a model that
    mangles one costs a row for no benefit — the caller holds the mapping.
    """
    blocks = []
    for n, row in enumerate(rows, start=1):
        parts = [f"[{n}]"]
        for field in fields:
            value = row.get(field)
            if value:
                parts.append(f"{field}: {value}")
        blocks.append("\n".join(parts))
    return f"{RULES}\n\n{glossary_block(glossary)}\n\n" + "\n\n".join(blocks)


def rows_schema(fields: Sequence[str]) -> dict:
    """JSON Schema for a batch response, passed to codex as --output-schema.

    Only the first field is required. A headline always exists; a lede often
    does not, and a schema that demanded one would make the model invent it.
    """
    return {
        "type": "object",
        "additionalProperties": {
            "type": "object",
            "properties": {f: {"type": "string"} for f in fields},
            "required": [fields[0]],
        },
    }


def parse_rows_response(
    payload: object, count: int, fields: Sequence[str]
) -> dict[int, dict[str, str]]:
    """Map a batch response to {zero-based position: {field: text}}.

    Entries that are out of range, unnumbered, or missing the required field are
    dropped rather than raising: one bad entry must not cost the other
    nineteen. A payload that is not an object at all raises, because that means
    the call itself failed and the batch should be retried.
    """
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ParseError(f"response is not JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ParseError(f"response is {type(payload).__name__}, not an object")

    out: dict[int, dict[str, str]] = {}
    for key, value in payload.items():
        try:
            index = int(str(key)) - 1
        except ValueError:
            continue
        if not (0 <= index < count) or not isinstance(value, dict):
            continue
        entry = {
            f: str(value[f]).strip()
            for f in fields
            if isinstance(value.get(f), str) and str(value[f]).strip()
        }
        if fields[0] not in entry:
            continue
        out[index] = entry
    return out
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_translatetext.py -v`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add jamasp/translatetext.py tests/test_translatetext.py
git commit -m "feat(translate): batch prompt, response schema and parser"
```

---

### Task 3: The model runner and its fake binary

**Files:**
- Create: `jamasp/modelrun.py`
- Create: `tests/fake_codex.py`
- Test: `tests/test_modelrun.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ModelError(RuntimeError)`
  - `run_json(cmd: Sequence[str], protocol: str, prompt: str, schema: dict, timeout: int) -> dict`

`run_json` is the only place in the codebase that spawns the translator. `translate.py` never sees a command or a protocol — it receives a callable.

- [ ] **Step 1: Write the fake binary**

Create `tests/fake_codex.py`:

```python
"""Stand-in for `codex exec` in translate tests.

Honours the two flags the codex protocol uses — `--output-schema FILE` and
`-o FILE` — and writes its answer to the `-o` path, exactly as codex does.
Stdout carries session noise, so a test proves the parser reads the file and
not the stream.

Mode comes from FAKE_CODEX_MODE:
  ok       echo each numbered entry back with an FA: prefix
  garbage  write prose to the output file
  empty    write nothing to the output file
  fail     exit non-zero
  hang     sleep past any sane timeout
  stdout   print the JSON to stdout instead (the `stdout` protocol)
"""
import json
import os
import re
import sys
import time

argv = sys.argv[1:]
prompt = argv[-1]
out_path = None
for flag in ("-o", "--output-last-message"):
    if flag in argv:
        out_path = argv[argv.index(flag) + 1]

mode = os.environ.get("FAKE_CODEX_MODE", "ok")

if mode == "fail":
    print("codex: boom", file=sys.stderr)
    sys.exit(1)
if mode == "hang":
    time.sleep(30)
    sys.exit(0)

answer = {
    n: {"headline": f"FA:{n}", "lede": f"FA-LEDE:{n}"}
    for n in re.findall(r"^\[(\d+)\]$", prompt, flags=re.MULTILINE)
}
body = json.dumps(answer, ensure_ascii=False)

if mode == "garbage":
    body = "I have translated the entries for you."
if mode == "empty":
    body = ""

print("[session] thinking…")  # noise the parser must ignore
if mode == "stdout":
    print(body)
else:
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(body)
sys.exit(0)
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_modelrun.py`:

```python
import sys

import pytest

from jamasp import modelrun

FAKE = [sys.executable, "tests/fake_codex.py"]
SCHEMA = {"type": "object"}
PROMPT = "[1]\nheadline: Gold climbs"


def run(protocol="codex", timeout=30, cmd=None):
    return modelrun.run_json(cmd or FAKE, protocol, PROMPT, SCHEMA, timeout)


def test_codex_protocol_reads_the_output_file_not_stdout(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "ok")
    assert run() == {"1": {"headline": "FA:1", "lede": "FA-LEDE:1"}}


def test_stdout_protocol_parses_the_last_json_object_on_stdout(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "stdout")
    assert run(protocol="stdout") == {"1": {"headline": "FA:1",
                                            "lede": "FA-LEDE:1"}}


def test_non_zero_exit_raises_model_error(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "fail")
    with pytest.raises(modelrun.ModelError, match="exit 1"):
        run()


def test_garbage_output_raises_model_error(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "garbage")
    with pytest.raises(modelrun.ModelError):
        run()


def test_empty_output_raises_model_error(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "empty")
    with pytest.raises(modelrun.ModelError):
        run()


def test_timeout_raises_model_error(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "hang")
    with pytest.raises(modelrun.ModelError, match="timed out"):
        run(timeout=1)


def test_missing_binary_raises_model_error():
    with pytest.raises(modelrun.ModelError):
        run(cmd=["definitely-not-a-real-binary-9f2a"])


def test_unknown_protocol_raises():
    with pytest.raises(ValueError, match="protocol"):
        run(protocol="carrier-pigeon")


def test_temp_files_are_cleaned_up(monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_CODEX_MODE", "ok")
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    run()
    assert list(tmp_path.glob("jamasp-translate-*")) == []
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_modelrun.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.modelrun'`.

- [ ] **Step 4: Write the module**

Create `jamasp/modelrun.py`:

```python
"""Spawn a translator command and return its JSON answer.

Two protocols, because the command is configurable:

  codex   `codex exec --output-schema S -o O <prompt>` — the response shape is
          enforced by the model runtime and the answer arrives in a file, so
          the session preamble on stdout can never contaminate the parse.
  stdout  `claude -p <prompt>` — the answer is the last JSON object printed.

This is the only module that spawns the translator. translate.py receives a
callable and never sees a command or a protocol.
"""
from __future__ import annotations

import contextlib
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Sequence

PROTOCOLS = ("codex", "stdout")


class ModelError(RuntimeError):
    """The translator failed, timed out, or returned unusable output."""


def _last_json_object(text: str) -> dict:
    """The last top-level JSON object in `text`.

    Scans backwards from each closing brace so a preamble line that happens to
    contain a brace cannot swallow the real answer.
    """
    for start in range(text.rfind("{"), -1, -1):
        if text[start] != "{":
            continue
        try:
            value = json.loads(text[start:text.rfind("}") + 1])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ModelError("no JSON object in model output")


def run_json(
    cmd: Sequence[str], protocol: str, prompt: str, schema: dict, timeout: int
) -> dict:
    """Run the translator and return its parsed response object."""
    if protocol not in PROTOCOLS:
        raise ValueError(f"unknown protocol {protocol!r}; expected one of {PROTOCOLS}")

    tmpdir = tempfile.mkdtemp(prefix="jamasp-translate-")
    try:
        argv = list(cmd)
        if protocol == "codex":
            schema_path = Path(tmpdir) / "schema.json"
            out_path = Path(tmpdir) / "answer.txt"
            schema_path.write_text(json.dumps(schema), encoding="utf-8")
            argv += ["--output-schema", str(schema_path), "-o", str(out_path)]
        argv.append(prompt)

        try:
            proc = subprocess.run(
                argv, capture_output=True, text=True, timeout=timeout
            )
        except subprocess.TimeoutExpired as exc:
            raise ModelError(f"translator timed out after {timeout}s") from exc
        except OSError as exc:
            raise ModelError(f"translator could not be run: {exc}") from exc

        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip()[-300:]
            raise ModelError(f"translator exit {proc.returncode}: {tail}")

        if protocol == "codex":
            try:
                text = out_path.read_text(encoding="utf-8")
            except OSError as exc:
                raise ModelError(f"translator wrote no answer file: {exc}") from exc
        else:
            text = proc.stdout

        if not text.strip():
            raise ModelError("translator returned an empty answer")
        return _last_json_object(text)
    finally:
        for entry in Path(tmpdir).iterdir():
            with contextlib.suppress(OSError):
                entry.unlink()
        with contextlib.suppress(OSError):
            os.rmdir(tmpdir)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_modelrun.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add jamasp/modelrun.py tests/fake_codex.py tests/test_modelrun.py
git commit -m "feat(translate): two-protocol model runner"
```

---

### Task 4: The reuse pass

**Files:**
- Create: `jamasp/translate.py`
- Test: `tests/test_translate.py`

**Interfaces:**
- Consumes: the `_fa` columns (Task 1).
- Produces: `reuse_flash_persian(conn: sqlite3.Connection, now: str | None = None) -> int` — returns the number of rows filled.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_translate.py`:

```python
from datetime import datetime, timedelta, timezone

from jamasp import db, translate
from jamasp.ingest import rss
from jamasp.models import Item


def ago(hours):
    dt = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def seed(conn, specs):
    """specs: list of (headline, hours_ago). Returns item ids."""
    items = [
        Item(
            id=rss.item_id("src", f"https://e/{i}", head),
            source="src",
            published_at=ago(hrs),
            headline=head,
            lede=f"lede for {head}",
            url=f"https://e/{i}",
            topic="gold",
        )
        for i, (head, hrs) in enumerate(specs)
    ]
    rss.store_items(conn, items)
    return [it.id for it in items]


def add_flash(conn, item_id, status="sent"):
    conn.execute(
        "INSERT INTO flashes (id, created_at, updated_at, title_en, title_fa,"
        " summary_fa, impact_fa, url, message_id, status)"
        " VALUES (?, ?, ?, 'EN', 'تیتر فارسی', 'خلاصه فارسی', 'اثر', 'u', 1, ?)",
        (item_id, ago(1), ago(1), status),
    )
    conn.commit()


def test_reuse_copies_persian_from_a_sent_flash(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("Gold climbs", 1)])
    add_flash(conn, one)

    assert translate.reuse_flash_persian(conn) == 1

    row = conn.execute("SELECT * FROM items WHERE id = ?", (one,)).fetchone()
    assert row["headline_fa"] == "تیتر فارسی"
    assert row["lede_fa"] == "خلاصه فارسی"
    assert row["fa_source"] == "flash"
    assert row["fa_at"] is not None


def test_reuse_ignores_orphaned_flashes(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("Gold climbs", 1)])
    add_flash(conn, one, status="orphaned")
    assert translate.reuse_flash_persian(conn) == 0
    row = conn.execute("SELECT headline_fa FROM items").fetchone()
    assert row["headline_fa"] is None


def test_reuse_never_overwrites_existing_persian(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("Gold climbs", 1)])
    add_flash(conn, one)
    conn.execute(
        "UPDATE items SET headline_fa = 'موجود', fa_source = 'model' WHERE id = ?",
        (one,),
    )
    conn.commit()
    assert translate.reuse_flash_persian(conn) == 0
    row = conn.execute("SELECT headline_fa, fa_source FROM items").fetchone()
    assert row["headline_fa"] == "موجود"
    assert row["fa_source"] == "model"


def test_reuse_leaves_items_without_a_flash_alone(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("No flash here", 1)])
    assert translate.reuse_flash_persian(conn) == 0


def test_reuse_is_idempotent(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("Gold climbs", 1)])
    add_flash(conn, one)
    assert translate.reuse_flash_persian(conn) == 1
    assert translate.reuse_flash_persian(conn) == 0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_translate.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.translate'`.

- [ ] **Step 3: Write the reuse pass**

Create `jamasp/translate.py`:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_translate.py -v`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add jamasp/translate.py tests/test_translate.py
git commit -m "feat(translate): reuse flash Persian before calling a model"
```

---

### Task 5: The rows pass

**Files:**
- Modify: `jamasp/translate.py`
- Test: `tests/test_translate.py`

**Interfaces:**
- Consumes: `translatetext.build_rows_prompt`, `rows_schema`, `parse_rows_response`, `ParseError` (Task 2); `modelrun.ModelError` (Task 3); `reuse_flash_persian` (Task 4).
- Produces:
  - `MAX_ATTEMPTS = 3`
  - `pending_rows(conn, window_days: int, limit: int, now: str | None = None) -> list[sqlite3.Row]`
  - `translate_rows(conn, cfg: dict, glossary: dict, run, now: str | None = None) -> dict` where `run` is `Callable[[str, dict], dict]` and the returned dict is `{"translated": int, "failed": int, "batches": int}`

`run` is injected rather than built here so tests never spawn a process and so the batch-then-singles fallback is exercised directly.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_translate.py`:

```python
import pytest

from jamasp import modelrun, translatetext

CFG = {"window_days": 7, "batch_size": 2, "max_batches_per_run": 10}
GLOSSARY = {"Fed": "فدرال رزرو"}


def fake_run(answers=None, fail_on=None, calls=None):
    """A run callable standing in for modelrun.run_json.

    Answers both prompt shapes: a document prompt (which asks for a `text`
    field) gets the source back with an FA: prefix; a rows prompt gets one
    numbered entry per `headline:` line. `fail_on` is a substring that makes
    the call raise.
    """
    def run(prompt, schema):
        if calls is not None:
            calls.append(prompt)
        if fail_on and fail_on in prompt:
            raise modelrun.ModelError("boom")
        if '"text"' in prompt:                       # a document prompt
            return {"text": "FA:" + prompt.split("---\n", 1)[1]}
        return answers if answers is not None else {
            str(i): {"headline": f"FA{i}", "lede": f"LEDE{i}"}
            for i in range(1, prompt.count("headline:") + 1)
        }
    return run


def test_pending_excludes_translated_and_out_of_window(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    fresh, old = seed(conn, [("Fresh", 1), ("Old", 24 * 9)])
    done = seed(conn, [("Done", 2)])[0]
    conn.execute("UPDATE items SET headline_fa = 'x' WHERE id = ?", (done,))
    conn.commit()
    ids = [r["id"] for r in translate.pending_rows(conn, window_days=7, limit=10)]
    assert ids == [fresh]
    assert old not in ids


def test_pending_is_newest_first(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    older, newer = seed(conn, [("Older", 5), ("Newer", 1)])
    ids = [r["id"] for r in translate.pending_rows(conn, 7, 10)]
    assert ids == [newer, older]


def test_pending_excludes_rows_at_the_attempt_cap(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("Bad row", 1)])
    conn.execute("UPDATE items SET fa_attempts = ? WHERE id = ?",
                 (translate.MAX_ATTEMPTS, one))
    conn.commit()
    assert translate.pending_rows(conn, 7, 10) == []


def test_translate_rows_writes_persian_and_marks_source_model(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1), ("Two", 2)])
    stats = translate.translate_rows(conn, CFG, GLOSSARY, fake_run())
    assert stats["translated"] == 2
    rows = conn.execute(
        "SELECT headline_fa, lede_fa, fa_source FROM items"
    ).fetchall()
    assert all(r["headline_fa"].startswith("FA") for r in rows)
    assert all(r["fa_source"] == "model" for r in rows)


def test_translate_rows_respects_the_batch_ceiling(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [(f"Item {i}", 1) for i in range(10)])
    calls = []
    cfg = {**CFG, "batch_size": 2, "max_batches_per_run": 2}
    stats = translate.translate_rows(conn, cfg, GLOSSARY, fake_run(calls=calls))
    assert stats["batches"] == 2
    assert len(calls) == 2
    assert stats["translated"] == 4


def test_a_failing_batch_retries_once_then_falls_back_to_singles(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1), ("Two", 2)])
    calls = []

    def run(prompt, schema):
        calls.append(prompt)
        if prompt.count("headline:") > 1:   # the batch, either attempt
            raise modelrun.ModelError("batch failed")
        return {"1": {"headline": "FA-single"}}

    stats = translate.translate_rows(conn, CFG, GLOSSARY, run)
    # batch, batch retry, then one call per row
    assert len(calls) == 4
    assert stats["translated"] == 2
    heads = {r["headline_fa"] for r in conn.execute("SELECT headline_fa FROM items")}
    assert heads == {"FA-single"}


def test_a_row_that_fails_alone_records_attempt_and_error(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])

    def run(prompt, schema):
        raise modelrun.ModelError("always fails")

    stats = translate.translate_rows(conn, CFG, GLOSSARY, run)
    assert stats["failed"] == 1
    row = conn.execute("SELECT fa_attempts, fa_error, headline_fa FROM items").fetchone()
    assert row["fa_attempts"] == 1
    assert "always fails" in row["fa_error"]
    assert row["headline_fa"] is None


def test_a_row_reaches_the_cap_after_three_runs_and_is_abandoned(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])

    def run(prompt, schema):
        raise modelrun.ModelError("nope")

    for _ in range(3):
        translate.translate_rows(conn, CFG, GLOSSARY, run)
    assert conn.execute("SELECT fa_attempts FROM items").fetchone()[0] == 3
    assert translate.pending_rows(conn, 7, 10) == []


def test_a_row_the_model_omits_counts_as_failed(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1), ("Two", 2)])
    # answer only for entry 1
    stats = translate.translate_rows(
        conn, CFG, GLOSSARY, fake_run(answers={"1": {"headline": "FA1"}})
    )
    assert stats["translated"] == 1
    assert stats["failed"] == 1


def test_a_lede_the_model_omits_leaves_lede_fa_null(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    translate.translate_rows(
        conn, CFG, GLOSSARY, fake_run(answers={"1": {"headline": "FA1"}})
    )
    row = conn.execute("SELECT headline_fa, lede_fa FROM items").fetchone()
    assert row["headline_fa"] == "FA1"
    assert row["lede_fa"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_translate.py -k "pending or translate_rows or batch or row_" -v`
Expected: FAIL — `AttributeError: module 'jamasp.translate' has no attribute 'pending_rows'`.

- [ ] **Step 3: Write the rows pass**

Append to `jamasp/translate.py` (and add the imports at the top):

```python
from datetime import datetime, timedelta, timezone
from typing import Callable, Sequence

from jamasp import modelrun, translatetext

MAX_ATTEMPTS = 3
ROW_FIELDS = ("headline", "lede")


def _since(window_days: int, now: str | None = None) -> str:
    base = datetime.strptime(now or utcnow(), "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc
    )
    return (base - timedelta(days=window_days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def pending_rows(
    conn: sqlite3.Connection, window_days: int, limit: int,
    now: str | None = None,
) -> list[sqlite3.Row]:
    """Untranslated items inside the window, newest first.

    Newest first is the priority order that matters: the freshest headline is
    the one somebody is looking at, and a backlog larger than a tick's ceiling
    drains from the top over subsequent ticks.

    The attempt cap is applied here rather than at write time so an abandoned
    row costs nothing to skip — it never enters a batch again.
    """
    return conn.execute(
        "SELECT id, headline, lede FROM items"
        " WHERE headline_fa IS NULL AND published_at >= ? AND fa_attempts < ?"
        " ORDER BY published_at DESC LIMIT ?",
        (_since(window_days, now), MAX_ATTEMPTS, limit),
    ).fetchall()


def _write_row(conn, item_id: str, entry: dict, now: str) -> None:
    conn.execute(
        "UPDATE items SET headline_fa = ?, lede_fa = ?, fa_source = 'model',"
        " fa_at = ?, fa_error = NULL WHERE id = ?",
        (entry["headline"], entry.get("lede"), now, item_id),
    )


def _record_failure(conn, item_id: str, error: str) -> None:
    conn.execute(
        "UPDATE items SET fa_attempts = fa_attempts + 1, fa_error = ?"
        " WHERE id = ?",
        (error[:500], item_id),
    )


def _translate_batch(
    rows: Sequence[sqlite3.Row], fields: Sequence[str], glossary: dict, run
) -> dict[int, dict[str, str]]:
    """One model call for `rows`, returning {position: {field: text}}.

    Raises ModelError or ParseError; the caller decides whether to retry the
    batch or fall back to singles.
    """
    prompt = translatetext.build_rows_prompt(rows, fields, glossary)
    payload = run(prompt, translatetext.rows_schema(fields))
    return translatetext.parse_rows_response(payload, len(rows), fields)


def _batch_with_fallback(
    conn, rows, fields, glossary, run, now, write, fail
) -> tuple[int, int]:
    """Translate one batch: try it, retry once, then one call per row.

    A malformed or refused response costs the whole batch, so one bad headline
    must not be allowed to poison nineteen good ones.
    """
    for attempt in (1, 2):
        try:
            answers = _translate_batch(rows, fields, glossary, run)
        except (modelrun.ModelError, translatetext.ParseError) as exc:
            if attempt == 2:
                last = str(exc)
                break
            continue
        translated = 0
        for position, row in enumerate(rows):
            entry = answers.get(position)
            if entry:
                write(conn, row["id"], entry, now)
                translated += 1
            else:
                fail(conn, row["id"], "model omitted this entry")
        conn.commit()
        return translated, len(rows) - translated

    translated = 0
    for row in rows:
        try:
            answers = _translate_batch([row], fields, glossary, run)
        except (modelrun.ModelError, translatetext.ParseError) as exc:
            fail(conn, row["id"], str(exc))
            continue
        entry = answers.get(0)
        if entry:
            write(conn, row["id"], entry, now)
            translated += 1
        else:
            fail(conn, row["id"], "model omitted this entry")
    conn.commit()
    return translated, len(rows) - translated


def translate_rows(
    conn: sqlite3.Connection, cfg: dict, glossary: dict,
    run: Callable[[str, dict], object], now: str | None = None,
) -> dict:
    """Translate pending items in batches. Returns counts."""
    stamp = now or utcnow()
    batch_size = cfg["batch_size"]
    ceiling = cfg["max_batches_per_run"]
    rows = pending_rows(conn, cfg["window_days"], batch_size * ceiling, now)

    translated = failed = batches = 0
    for start in range(0, len(rows), batch_size):
        chunk = rows[start:start + batch_size]
        ok, bad = _batch_with_fallback(
            conn, chunk, ROW_FIELDS, glossary, run, stamp,
            _write_row, _record_failure,
        )
        translated += ok
        failed += bad
        batches += 1
    return {"translated": translated, "failed": failed, "batches": batches}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_translate.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add jamasp/translate.py tests/test_translate.py
git commit -m "feat(translate): batched rows pass with singles fallback"
```

---

### Task 6: The events pass

**Files:**
- Modify: `jamasp/translate.py`
- Test: `tests/test_translate.py`

**Interfaces:**
- Consumes: `_batch_with_fallback`, `_since`, `MAX_ATTEMPTS` (Task 5).
- Produces:
  - `EVENT_FIELDS = ("title",)`
  - `pending_events(conn, window_days: int, limit: int, now: str | None = None) -> list[sqlite3.Row]`
  - `translate_events(conn, cfg, glossary, run, now=None) -> dict` with the same `{"translated", "failed", "batches"}` shape.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_translate.py`:

```python
def add_event(conn, event_id, title, hours_from_now):
    dt = datetime.now(timezone.utc) + timedelta(hours=hours_from_now)
    conn.execute(
        "INSERT INTO events (id, source, title, country, impact, starts_at,"
        " fetched_at) VALUES (?, 'cal', ?, 'US', 'high', ?, ?)",
        (event_id, title, dt.strftime("%Y-%m-%dT%H:%M:%SZ"), ago(1)),
    )
    conn.commit()


def test_pending_events_includes_future_and_recent_past(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    add_event(conn, "e1", "US CPI (MoM)", 48)       # future
    add_event(conn, "e2", "FOMC Statement", -24)    # yesterday
    add_event(conn, "e3", "Ancient event", -24 * 30)
    ids = [r["id"] for r in translate.pending_events(conn, 7, 10)]
    assert set(ids) == {"e1", "e2"}


def test_translate_events_writes_title_fa(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    add_event(conn, "e1", "US CPI (MoM)", 24)

    def run(prompt, schema):
        assert "US CPI (MoM)" in prompt
        return {"1": {"title": "شاخص قیمت مصرف‌کننده آمریکا (ماهانه)"}}

    stats = translate.translate_events(conn, CFG, GLOSSARY, run)
    assert stats["translated"] == 1
    row = conn.execute("SELECT title_fa, fa_at FROM events").fetchone()
    assert row["title_fa"].startswith("شاخص")
    assert row["fa_at"] is not None


def test_translate_events_records_failure_on_the_event_row(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    add_event(conn, "e1", "US CPI (MoM)", 24)

    def run(prompt, schema):
        raise modelrun.ModelError("event boom")

    assert translate.translate_events(conn, CFG, GLOSSARY, run)["failed"] == 1
    row = conn.execute("SELECT fa_attempts, fa_error FROM events").fetchone()
    assert row["fa_attempts"] == 1
    assert "event boom" in row["fa_error"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_translate.py -k event -v`
Expected: FAIL — `AttributeError: ... has no attribute 'pending_events'`.

- [ ] **Step 3: Write the events pass**

Append to `jamasp/translate.py`:

```python
EVENT_FIELDS = ("title",)


def pending_events(
    conn: sqlite3.Connection, window_days: int, limit: int,
    now: str | None = None,
) -> list[sqlite3.Row]:
    """Untranslated events from the recent past forward, soonest first.

    No upper bound: the calendar is a forward-looking view, so every future
    event qualifies. The window only bounds how far back a just-passed event
    stays worth translating.
    """
    return conn.execute(
        "SELECT id, title FROM events"
        " WHERE title_fa IS NULL AND starts_at >= ? AND fa_attempts < ?"
        " ORDER BY starts_at LIMIT ?",
        (_since(window_days, now), MAX_ATTEMPTS, limit),
    ).fetchall()


def _write_event(conn, event_id: str, entry: dict, now: str) -> None:
    conn.execute(
        "UPDATE events SET title_fa = ?, fa_at = ?, fa_error = NULL WHERE id = ?",
        (entry["title"], now, event_id),
    )


def _record_event_failure(conn, event_id: str, error: str) -> None:
    conn.execute(
        "UPDATE events SET fa_attempts = fa_attempts + 1, fa_error = ?"
        " WHERE id = ?",
        (error[:500], event_id),
    )


def translate_events(
    conn: sqlite3.Connection, cfg: dict, glossary: dict,
    run: Callable[[str, dict], object], now: str | None = None,
) -> dict:
    """Translate pending calendar events in batches. Returns counts."""
    stamp = now or utcnow()
    batch_size = cfg["batch_size"]
    ceiling = cfg["max_batches_per_run"]
    rows = pending_events(conn, cfg["window_days"], batch_size * ceiling, now)

    translated = failed = batches = 0
    for start in range(0, len(rows), batch_size):
        chunk = rows[start:start + batch_size]
        ok, bad = _batch_with_fallback(
            conn, chunk, EVENT_FIELDS, glossary, run, stamp,
            _write_event, _record_event_failure,
        )
        translated += ok
        failed += bad
        batches += 1
    return {"translated": translated, "failed": failed, "batches": batches}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_translate.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add jamasp/translate.py tests/test_translate.py
git commit -m "feat(translate): calendar events pass"
```

---

### Task 7: Sidecar primitives — hashing, front matter, atomic writes

**Files:**
- Modify: `jamasp/translatetext.py`
- Test: `tests/test_translatetext.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src_hash(text: str) -> str` — sha256 hex of the UTF-8 text
  - `render_front_matter(source_hash: str, translated_at: str, translator: str) -> str`
  - `parse_front_matter(text: str) -> tuple[dict[str, str], str]` — `(meta, body)`; `({}, text)` when there is none
  - `write_atomic(path: Path, text: str) -> None`

`write_atomic` lives here despite touching the filesystem because it is the one exception that keeps sidecar writing in one place; everything else in the module stays pure.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_translatetext.py`:

```python
def test_src_hash_is_stable_and_content_sensitive():
    assert tt.src_hash("abc") == tt.src_hash("abc")
    assert tt.src_hash("abc") != tt.src_hash("abd")
    assert len(tt.src_hash("abc")) == 64


def test_src_hash_handles_persian():
    assert tt.src_hash("طلا") != tt.src_hash("نقره")


def test_front_matter_round_trips():
    fm = tt.render_front_matter("deadbeef", "2026-09-13T06:14:00Z", "codex")
    meta, body = tt.parse_front_matter(fm + "متن فارسی\n")
    assert meta["src_hash"] == "deadbeef"
    assert meta["translated_at"] == "2026-09-13T06:14:00Z"
    assert meta["translator"] == "codex"
    assert body == "متن فارسی\n"


def test_parse_front_matter_returns_empty_meta_when_absent():
    meta, body = tt.parse_front_matter("just a document\n")
    assert meta == {}
    assert body == "just a document\n"


def test_parse_front_matter_tolerates_a_stray_leading_blank_line():
    fm = tt.render_front_matter("h", "t", "codex")
    meta, _ = tt.parse_front_matter("\n" + fm + "body")
    assert meta == {}   # front matter must be the first thing, or it is body


def test_write_atomic_leaves_no_partial_file(tmp_path):
    target = tmp_path / "out.md"
    tt.write_atomic(target, "first\n")
    tt.write_atomic(target, "second\n")
    assert target.read_text(encoding="utf-8") == "second\n"
    assert list(tmp_path.glob("*.tmp*")) == []


def test_write_atomic_creates_parent_directories(tmp_path):
    target = tmp_path / "2026" / "09" / "brief.fa.md"
    tt.write_atomic(target, "x")
    assert target.read_text(encoding="utf-8") == "x"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_translatetext.py -k "hash or front_matter or atomic" -v`
Expected: FAIL — `AttributeError: module 'jamasp.translatetext' has no attribute 'src_hash'`.

- [ ] **Step 3: Write the primitives**

First replace the module's import block with this exact set:

```python
import contextlib
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Mapping, Sequence
```

Then append:

```python
FRONT_MATTER_FENCE = "---"


def src_hash(text: str) -> str:
    """sha256 of the English source, hex.

    This is what makes the document track correct where an empty check would be
    wrong: stance.md is rewritten at the end of every run, and "translate it if
    the sidecar is missing" would serve a months-stale Persian stance.
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def render_front_matter(
    source_hash: str, translated_at: str, translator: str
) -> str:
    return (
        f"{FRONT_MATTER_FENCE}\n"
        f"src_hash: {source_hash}\n"
        f"translated_at: {translated_at}\n"
        f"translator: {translator}\n"
        f"{FRONT_MATTER_FENCE}\n"
    )


def parse_front_matter(text: str) -> tuple[dict[str, str], str]:
    """Split a sidecar into (meta, body). No front matter yields ({}, text).

    Front matter must open on the very first line. A file that merely contains
    a `---` somewhere is a body, not a sidecar with metadata, and treating it
    as one would invent a hash that never matches.
    """
    if not text.startswith(f"{FRONT_MATTER_FENCE}\n"):
        return {}, text
    end = text.find(f"\n{FRONT_MATTER_FENCE}\n", len(FRONT_MATTER_FENCE))
    if end == -1:
        return {}, text
    block = text[len(FRONT_MATTER_FENCE) + 1:end]
    meta = {}
    for line in block.splitlines():
        key, sep, value = line.partition(":")
        if sep:
            meta[key.strip()] = value.strip()
    return meta, text[end + len(FRONT_MATTER_FENCE) + 2:]


def write_atomic(path: Path, text: str) -> None:
    """Write `text` to `path` via a same-directory temp file and os.replace.

    The panel reads these files on every render, so a half-written document is
    a rendering bug waiting to happen. Same directory because os.replace is
    only atomic within a filesystem.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_translatetext.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add jamasp/translatetext.py tests/test_translatetext.py
git commit -m "feat(translate): sidecar hashing, front matter and atomic writes"
```

---

### Task 8: The stance sidecar

**Files:**
- Modify: `jamasp/translatetext.py`, `jamasp/translate.py`
- Test: `tests/test_translatetext.py`, `tests/test_translate.py`

**Interfaces:**
- Consumes: `src_hash`, `render_front_matter`, `parse_front_matter`, `write_atomic` (Task 7); `_batch_with_fallback` is **not** used here — documents are one call each.
- Produces:
  - `split_sections(markdown: str) -> list[tuple[str, str]]` — `[(heading_line, body)]`
  - `render_stance_sidecar(sections: list[tuple[str, str, str]], translated_at: str, translator: str) -> str` — sections are `(english_heading, section_hash, persian_body)`
  - `parse_stance_sidecar(text: str) -> list[tuple[str, str, str]]` — the inverse
  - `build_doc_prompt(text: str, glossary: dict) -> str`, `doc_schema() -> dict`, `parse_doc_response(payload) -> str`
  - `translate_stance(source: Path, sidecar: Path, glossary, run, now=None, translator="codex", force=False) -> dict`

The English headings are anchors, never rendered — the panel takes headings from its own dictionary. Keeping them verbatim means the sidecar splits with the same logic as the source, so section matching cannot drift.

- [ ] **Step 1: Write the failing text tests**

Append to `tests/test_translatetext.py`:

```python
STANCE = """As of 2026-09-13.

## View
Gold is bid. Weights 70/5/25 (base/event-bearish/kinetic).

## What flips me
- A hot CPI print.
"""


def test_split_sections_keeps_preamble_under_an_empty_heading():
    sections = tt.split_sections(STANCE)
    assert sections[0][0] == ""
    assert "As of 2026-09-13." in sections[0][1]
    assert sections[1][0] == "## View"
    assert sections[2][0] == "## What flips me"


def test_split_sections_of_a_headingless_document():
    assert tt.split_sections("just prose\n") == [("", "just prose\n")]


def test_stance_sidecar_round_trips():
    sections = [("## View", "aaa", "طلا خریدار دارد.\n"),
                ("## What flips me", "bbb", "- یک CPI داغ.\n")]
    text = tt.render_stance_sidecar(sections, "2026-09-13T06:14:00Z", "codex")
    assert tt.parse_stance_sidecar(text) == sections


def test_stance_sidecar_keeps_english_headings_verbatim():
    text = tt.render_stance_sidecar(
        [("## What flips me", "h", "بدنه\n")], "t", "codex")
    assert "## What flips me" in text
    assert "بدنه" in text


def test_parse_stance_sidecar_of_an_empty_file_is_empty():
    assert tt.parse_stance_sidecar("") == []


def test_doc_prompt_carries_glossary_and_source():
    prompt = tt.build_doc_prompt("Gold is bid.", GLOSSARY)
    assert "Gold is bid." in prompt
    assert "فدرال رزرو" in prompt


def test_parse_doc_response_takes_the_text_field():
    assert tt.parse_doc_response({"text": "متن"}) == "متن"


def test_parse_doc_response_rejects_a_missing_field():
    with pytest.raises(tt.ParseError):
        tt.parse_doc_response({"nope": "x"})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_translatetext.py -k "section or stance or doc_" -v`
Expected: FAIL — `AttributeError: ... has no attribute 'split_sections'`.

- [ ] **Step 3: Write the text functions**

Append to `jamasp/translatetext.py`:

```python
SECTION_HASH_PREFIX = "<!-- src_hash: "


def split_sections(markdown: str) -> list[tuple[str, str]]:
    """Split a document at its `##` headings into [(heading_line, body)].

    Anything before the first heading is returned under an empty heading, so a
    document's preamble is never silently dropped.
    """
    sections: list[tuple[str, str]] = []
    heading, body = "", []
    for line in markdown.splitlines(keepends=True):
        if line.startswith("## "):
            sections.append((heading, "".join(body)))
            heading, body = line.rstrip("\n"), []
        else:
            body.append(line)
    sections.append((heading, "".join(body)))
    return sections


def render_stance_sidecar(
    sections: list[tuple[str, str, str]], translated_at: str, translator: str
) -> str:
    """Sidecar text from [(english_heading, section_hash, persian_body)].

    The English heading is an anchor, never rendered: the panel takes headings
    from its own dictionary because StanceKey is a closed enum. Keeping it
    verbatim means this file splits with the same logic as the source, so
    section matching cannot drift between the two.
    """
    out = [render_front_matter("", translated_at, translator)]
    for heading, section_hash, body in sections:
        if heading:
            out.append(f"{heading}\n")
        out.append(f"{SECTION_HASH_PREFIX}{section_hash} -->\n")
        out.append(body if body.endswith("\n") or not body else body + "\n")
    return "".join(out)


def parse_stance_sidecar(text: str) -> list[tuple[str, str, str]]:
    """The inverse of render_stance_sidecar. Malformed input yields []."""
    _, body = parse_front_matter(text)
    if not body.strip():
        return []
    out: list[tuple[str, str, str]] = []
    for heading, chunk in split_sections(body):
        lines = chunk.splitlines(keepends=True)
        if not lines or not lines[0].startswith(SECTION_HASH_PREFIX):
            continue
        section_hash = lines[0][len(SECTION_HASH_PREFIX):].split(" -->")[0].strip()
        out.append((heading, section_hash, "".join(lines[1:])))
    return out


DOC_RULES = (
    "Translate the document below into Persian (Farsi).\n"
    "- Translate faithfully. Do not editorialize, summarise, or reorder.\n"
    "- Preserve markdown structure exactly: lists stay lists, emphasis stays"
    " emphasis, and every number, ticker and percentage keeps its Latin form.\n"
    "- Do not translate headings; they are not included.\n"
    "- Apply the glossary.\n"
    '- Return a JSON object: {"text": "<the Persian document>"}.'
)


def build_doc_prompt(text: str, glossary: Mapping[str, str]) -> str:
    return f"{DOC_RULES}\n\n{glossary_block(glossary)}\n\n---\n{text}"


def doc_schema() -> dict:
    return {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    }


def parse_doc_response(payload: object) -> str:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ParseError(f"document response is not JSON: {exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
        raise ParseError("document response has no `text` string")
    return payload["text"]
```

- [ ] **Step 4: Write the failing stance-job test**

Append to `tests/test_translate.py`:

```python
from pathlib import Path

from jamasp import translatetext as tt

STANCE_MD = """As of 2026-09-13.

## View
Gold is bid. Weights 70/5/25 (base/event-bearish/kinetic).

## What flips me
- A hot CPI print.
"""


def doc_run(prefix="FA:"):
    def run(prompt, schema):
        source = prompt.split("---\n", 1)[1]
        return {"text": prefix + source}
    return run


def test_translate_stance_writes_a_sidecar_per_section(tmp_path):
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"

    stats = translate.translate_stance(src, side, GLOSSARY, doc_run())

    assert stats["translated"] == 3   # preamble + two sections
    sections = tt.parse_stance_sidecar(side.read_text(encoding="utf-8"))
    assert [h for h, _, _ in sections] == ["", "## View", "## What flips me"]
    assert all(body.startswith("FA:") for _, _, body in sections)


def test_translate_stance_is_a_noop_when_nothing_changed(tmp_path):
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run())

    calls = []

    def counting(prompt, schema):
        calls.append(prompt)
        return {"text": "unused"}

    stats = translate.translate_stance(src, side, GLOSSARY, counting)
    assert stats["translated"] == 0
    assert calls == []


def test_a_rewritten_section_retranslates_only_that_section(tmp_path):
    """The failure mode an empty check cannot see: stance is rewritten daily."""
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))

    src.write_text(STANCE_MD.replace("Gold is bid.", "Gold is offered."),
                   encoding="utf-8")
    calls = []

    def counting(prompt, schema):
        calls.append(prompt)
        return {"text": "NEW:changed"}

    stats = translate.translate_stance(src, side, GLOSSARY, counting)
    assert stats["translated"] == 1
    assert len(calls) == 1

    sections = dict(
        (h, b) for h, _, b in
        tt.parse_stance_sidecar(side.read_text(encoding="utf-8"))
    )
    assert sections["## View"].startswith("NEW:")
    assert sections["## What flips me"].startswith("OLD:")


def test_translate_stance_force_retranslates_everything(tmp_path):
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))
    stats = translate.translate_stance(
        src, side, GLOSSARY, doc_run("NEW:"), force=True)
    assert stats["translated"] == 3


def test_translate_stance_keeps_the_old_sidecar_when_a_section_fails(tmp_path):
    src = tmp_path / "stance.md"
    src.write_text(STANCE_MD, encoding="utf-8")
    side = tmp_path / "stance.fa.md"
    translate.translate_stance(src, side, GLOSSARY, doc_run("OLD:"))
    before = side.read_text(encoding="utf-8")

    src.write_text(STANCE_MD.replace("Gold is bid.", "Gold is offered."),
                   encoding="utf-8")

    def failing(prompt, schema):
        raise modelrun.ModelError("doc boom")

    stats = translate.translate_stance(src, side, GLOSSARY, failing)
    assert stats["failed"] == 1
    # the unchanged sections survive; the failed one keeps its previous Persian
    assert "OLD:" in side.read_text(encoding="utf-8")
    assert side.read_text(encoding="utf-8") == before


def test_translate_stance_with_no_source_is_a_noop(tmp_path):
    stats = translate.translate_stance(
        tmp_path / "absent.md", tmp_path / "absent.fa.md", GLOSSARY, doc_run())
    assert stats == {"translated": 0, "failed": 0}
```

- [ ] **Step 5: Run the stance tests to verify they fail**

Run: `uv run pytest tests/test_translate.py -k stance -v`
Expected: FAIL — `AttributeError: ... has no attribute 'translate_stance'`.

- [ ] **Step 6: Write `translate_stance`**

Append to `jamasp/translate.py` (add `from pathlib import Path`):

```python
DEFAULT_TRANSLATOR = "codex"


def _translate_text(text: str, glossary: dict, run) -> str:
    """One model call for one document or section."""
    prompt = translatetext.build_doc_prompt(text, glossary)
    return translatetext.parse_doc_response(
        run(prompt, translatetext.doc_schema())
    )


def translate_stance(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, translator: str = DEFAULT_TRANSLATOR,
    force: bool = False,
) -> dict:
    """Translate stance.md section by section into its sidecar.

    Per-section hashing because a brief run usually rewrites one section and
    leaves five alone; hashing the whole file would pay for all six every day.

    A section that fails keeps whatever Persian it already had, and the sidecar
    is rewritten only when something actually changed — so a total failure
    leaves the previous file byte-identical rather than half-updated.
    """
    if not source.exists():
        return {"translated": 0, "failed": 0}

    existing = {}
    if sidecar.exists():
        existing = {
            heading: (section_hash, body)
            for heading, section_hash, body
            in translatetext.parse_stance_sidecar(
                sidecar.read_text(encoding="utf-8"))
        }

    translated = failed = 0
    out: list[tuple[str, str, str]] = []
    for heading, body in translatetext.split_sections(
        source.read_text(encoding="utf-8")
    ):
        digest = translatetext.src_hash(body)
        previous = existing.get(heading)
        if not force and previous and previous[0] == digest:
            out.append((heading, digest, previous[1]))
            continue
        if not body.strip():
            out.append((heading, digest, body))
            continue
        try:
            out.append((heading, digest, _translate_text(body, glossary, run)))
            translated += 1
        except (modelrun.ModelError, translatetext.ParseError):
            # Keep the previous Persian for this section, and keep its OLD
            # hash so the next run tries again rather than believing it is done.
            out.append((heading, previous[0] if previous else "", 
                        previous[1] if previous else body))
            failed += 1

    if translated:
        translatetext.write_atomic(
            sidecar,
            translatetext.render_stance_sidecar(
                out, now or utcnow(), translator),
        )
    return {"translated": translated, "failed": failed}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `uv run pytest tests/test_translate.py tests/test_translatetext.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add jamasp/translatetext.py jamasp/translate.py tests/test_translatetext.py tests/test_translate.py
git commit -m "feat(translate): per-section stance sidecar"
```

---

### Task 9: The remaining document sidecars

**Files:**
- Modify: `jamasp/translate.py`
- Test: `tests/test_translate.py`

**Interfaces:**
- Consumes: `_translate_text`, `translatetext.src_hash`, `render_front_matter`, `parse_front_matter`, `write_atomic` (Tasks 7-8).
- Produces:
  - `translate_document(source: Path, sidecar: Path, glossary, run, now=None, translator="codex", force=False) -> dict` — whole-document sidecars (playbook, reports)
  - `translate_watchlist(source: Path, sidecar: Path, glossary, run, now=None, force=False) -> dict`
  - `translate_predictions(source: Path, sidecar: Path, glossary, run, now=None, force=False) -> dict`
  - `new_reports(reports_dir: Path, since_iso: str) -> list[Path]`
  - `translate_docs(root: Path, cfg: dict, glossary: dict, run, now=None, force=False) -> dict`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_translate.py`:

```python
import json

import yaml


def test_translate_document_writes_front_matter_and_body(tmp_path):
    src = tmp_path / "playbook.md"
    src.write_text("Buy dips in an easing cycle.\n", encoding="utf-8")
    side = tmp_path / "playbook.fa.md"

    assert translate.translate_document(src, side, GLOSSARY, doc_run())["translated"] == 1

    meta, body = tt.parse_front_matter(side.read_text(encoding="utf-8"))
    assert meta["src_hash"] == tt.src_hash("Buy dips in an easing cycle.\n")
    assert meta["translator"] == "codex"
    assert body.startswith("FA:")


def test_translate_document_skips_an_unchanged_source(tmp_path):
    src = tmp_path / "playbook.md"
    src.write_text("Same.\n", encoding="utf-8")
    side = tmp_path / "playbook.fa.md"
    translate.translate_document(src, side, GLOSSARY, doc_run())

    def boom(prompt, schema):
        raise AssertionError("should not have been called")

    assert translate.translate_document(src, side, GLOSSARY, boom)["translated"] == 0


def test_translate_document_retranslates_a_changed_source(tmp_path):
    src = tmp_path / "playbook.md"
    src.write_text("First.\n", encoding="utf-8")
    side = tmp_path / "playbook.fa.md"
    translate.translate_document(src, side, GLOSSARY, doc_run("OLD:"))
    src.write_text("Second.\n", encoding="utf-8")
    translate.translate_document(src, side, GLOSSARY, doc_run("NEW:"))
    _, body = tt.parse_front_matter(side.read_text(encoding="utf-8"))
    assert body.startswith("NEW:")


def test_translate_document_leaves_the_sidecar_intact_on_failure(tmp_path):
    src = tmp_path / "playbook.md"
    src.write_text("First.\n", encoding="utf-8")
    side = tmp_path / "playbook.fa.md"
    translate.translate_document(src, side, GLOSSARY, doc_run("OLD:"))
    before = side.read_text(encoding="utf-8")
    src.write_text("Second.\n", encoding="utf-8")

    def failing(prompt, schema):
        raise modelrun.ModelError("nope")

    assert translate.translate_document(src, side, GLOSSARY, failing)["failed"] == 1
    assert side.read_text(encoding="utf-8") == before


def test_translate_watchlist_keys_by_theme_and_hashes_each_why(tmp_path):
    src = tmp_path / "watchlist.yaml"
    src.write_text(
        yaml.safe_dump({"watchlist": [
            {"theme": "real_yields", "why": "Real yields lead gold.",
             "since": "2026-08-01"},
            {"theme": "cb_buying", "why": "Central banks keep buying.",
             "since": "2026-08-05"},
        ]}, allow_unicode=True),
        encoding="utf-8",
    )
    side = tmp_path / "watchlist.fa.yaml"

    assert translate.translate_watchlist(src, side, GLOSSARY, doc_run())["translated"] == 2

    doc = yaml.safe_load(side.read_text(encoding="utf-8"))
    entries = {e["theme"]: e for e in doc["watchlist"]}
    assert entries["real_yields"]["why_fa"].startswith("FA:")
    assert entries["real_yields"]["src_hash"] == tt.src_hash("Real yields lead gold.")
    assert "why" not in entries["real_yields"]   # the sidecar carries only Persian


def test_translate_watchlist_only_retranslates_changed_entries(tmp_path):
    src = tmp_path / "watchlist.yaml"
    entries = [{"theme": "a", "why": "One.", "since": "2026-08-01"},
               {"theme": "b", "why": "Two.", "since": "2026-08-01"}]
    src.write_text(yaml.safe_dump({"watchlist": entries}), encoding="utf-8")
    side = tmp_path / "watchlist.fa.yaml"
    translate.translate_watchlist(src, side, GLOSSARY, doc_run("OLD:"))

    entries[0]["why"] = "One changed."
    src.write_text(yaml.safe_dump({"watchlist": entries}), encoding="utf-8")
    calls = []

    def counting(prompt, schema):
        calls.append(prompt)
        return {"text": "NEW:x"}

    assert translate.translate_watchlist(src, side, GLOSSARY, counting)["translated"] == 1
    assert len(calls) == 1
    doc = {e["theme"]: e for e in
           yaml.safe_load(side.read_text(encoding="utf-8"))["watchlist"]}
    assert doc["a"]["why_fa"] == "NEW:x"
    assert doc["b"]["why_fa"].startswith("OLD:")


def test_translate_predictions_keys_by_id_and_keeps_jsonl(tmp_path):
    src = tmp_path / "predictions.jsonl"
    src.write_text(
        json.dumps({"id": "p1", "claim": "Gold holds 2600."}) + "\n"
        + json.dumps({"id": "p2", "claim": "DXY breaks 105."}) + "\n",
        encoding="utf-8",
    )
    side = tmp_path / "predictions.fa.jsonl"

    assert translate.translate_predictions(src, side, GLOSSARY, doc_run())["translated"] == 2

    lines = [json.loads(l) for l in
             side.read_text(encoding="utf-8").splitlines() if l.strip()]
    assert {l["id"] for l in lines} == {"p1", "p2"}
    assert lines[0]["claim_fa"].startswith("FA:")
    assert lines[0]["src_hash"] == tt.src_hash("Gold holds 2600.")


def test_translate_predictions_skips_lines_already_translated(tmp_path):
    src = tmp_path / "predictions.jsonl"
    src.write_text(json.dumps({"id": "p1", "claim": "Same."}) + "\n",
                   encoding="utf-8")
    side = tmp_path / "predictions.fa.jsonl"
    translate.translate_predictions(src, side, GLOSSARY, doc_run())

    def boom(prompt, schema):
        raise AssertionError("should not have been called")

    assert translate.translate_predictions(src, side, GLOSSARY, boom)["translated"] == 0


def test_translate_predictions_tolerates_a_malformed_line(tmp_path):
    src = tmp_path / "predictions.jsonl"
    src.write_text('{"id": "p1", "claim": "Fine."}\n{not json\n',
                   encoding="utf-8")
    side = tmp_path / "predictions.fa.jsonl"
    assert translate.translate_predictions(src, side, GLOSSARY, doc_run())["translated"] == 1


def test_new_reports_finds_only_untranslated_reports(tmp_path):
    reports = tmp_path / "reports" / "2026" / "09"
    reports.mkdir(parents=True)
    (reports / "2026-09-12-brief.md").write_text("A brief.\n", encoding="utf-8")
    (reports / "2026-09-11-brief.md").write_text("Older.\n", encoding="utf-8")
    (reports / "2026-09-11-brief.fa.md").write_text("x", encoding="utf-8")
    found = translate.new_reports(tmp_path / "reports", "2026-09-12")
    assert [p.name for p in found] == ["2026-09-12-brief.md"]


def test_new_reports_ignores_sidecars_themselves(tmp_path):
    reports = tmp_path / "reports" / "2026" / "09"
    reports.mkdir(parents=True)
    (reports / "2026-09-12-brief.fa.md").write_text("x", encoding="utf-8")
    assert translate.new_reports(tmp_path / "reports", "2026-01-01") == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_translate.py -k "document or watchlist or predictions or new_reports" -v`
Expected: FAIL — `AttributeError: ... has no attribute 'translate_document'`.

- [ ] **Step 3: Write the document passes**

Append to `jamasp/translate.py` (add `import json` and `import yaml`):

```python
def translate_document(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, translator: str = DEFAULT_TRANSLATOR,
    force: bool = False,
) -> dict:
    """Whole-document sidecar: playbook and reports.

    Nothing parses these structurally, so unlike stance they translate as one
    unit, headings included. A failure leaves the existing sidecar byte-
    identical: a stale Persian document is better than none, and the hash
    mismatch is what keeps the panel honest about it.
    """
    if not source.exists():
        return {"translated": 0, "failed": 0}
    text = source.read_text(encoding="utf-8")
    digest = translatetext.src_hash(text)

    if not force and sidecar.exists():
        meta, _ = translatetext.parse_front_matter(
            sidecar.read_text(encoding="utf-8"))
        if meta.get("src_hash") == digest:
            return {"translated": 0, "failed": 0}

    try:
        persian = _translate_text(text, glossary, run)
    except (modelrun.ModelError, translatetext.ParseError):
        return {"translated": 0, "failed": 1}

    translatetext.write_atomic(
        sidecar,
        translatetext.render_front_matter(digest, now or utcnow(), translator)
        + persian,
    )
    return {"translated": 1, "failed": 0}


def translate_watchlist(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, force: bool = False,
) -> dict:
    """Sidecar keyed by theme, carrying only Persian and a hash.

    The English `why` is deliberately not copied across: duplicating it would
    create a second copy that drifts the moment a brief rewrites the original.
    """
    if not source.exists():
        return {"translated": 0, "failed": 0}
    entries = (yaml.safe_load(source.read_text(encoding="utf-8")) or {}).get(
        "watchlist") or []

    existing = {}
    if sidecar.exists():
        prior = (yaml.safe_load(sidecar.read_text(encoding="utf-8")) or {}).get(
            "watchlist") or []
        existing = {e.get("theme"): e for e in prior}

    translated = failed = 0
    out = []
    for entry in entries:
        theme, why = entry.get("theme", ""), entry.get("why", "")
        digest = translatetext.src_hash(why)
        previous = existing.get(theme)
        if not force and previous and previous.get("src_hash") == digest:
            out.append(previous)
            continue
        try:
            out.append({"theme": theme,
                        "why_fa": _translate_text(why, glossary, run),
                        "src_hash": digest})
            translated += 1
        except (modelrun.ModelError, translatetext.ParseError):
            if previous:
                out.append(previous)
            failed += 1

    if translated:
        translatetext.write_atomic(
            sidecar,
            yaml.safe_dump({"watchlist": out}, allow_unicode=True,
                           sort_keys=False),
        )
    return {"translated": translated, "failed": failed}


def translate_predictions(
    source: Path, sidecar: Path, glossary: dict, run,
    now: str | None = None, force: bool = False,
) -> dict:
    """Sidecar keyed by prediction id, one JSON object per line.

    A sidecar rather than a `claim_fa` field in the source because
    `jamasp predictions add` appends to that file; rewriting it here would race
    an append and could lose a prediction.
    """
    if not source.exists():
        return {"translated": 0, "failed": 0}

    existing = {}
    if sidecar.exists():
        for line in sidecar.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                existing[row.get("id")] = row

    translated = failed = 0
    out = []
    for line in source.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue   # an interrupted append; the source reader skips it too
        pid, claim = row.get("id"), row.get("claim", "")
        digest = translatetext.src_hash(claim)
        previous = existing.get(pid)
        if not force and previous and previous.get("src_hash") == digest:
            out.append(previous)
            continue
        try:
            out.append({"id": pid,
                        "claim_fa": _translate_text(claim, glossary, run),
                        "src_hash": digest})
            translated += 1
        except (modelrun.ModelError, translatetext.ParseError):
            if previous:
                out.append(previous)
            failed += 1

    if translated:
        translatetext.write_atomic(
            sidecar,
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in out),
        )
    return {"translated": translated, "failed": failed}


def new_reports(reports_dir: Path, since_iso: str) -> list[Path]:
    """Reports dated on or after `since_iso` that have no sidecar yet.

    Spec decision 18: new reports only. The archive behind the ship date stays
    English, which is arguably correct — those briefs were written in English.
    """
    if not reports_dir.exists():
        return []
    out = []
    for path in sorted(reports_dir.rglob("*.md")):
        if path.name.endswith(".fa.md"):
            continue
        if path.name[:10] < since_iso[:10]:
            continue
        if not path.with_name(path.name[:-3] + ".fa.md").exists():
            out.append(path)
    return out
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_translate.py -v`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the combined docs pass**

Append to `tests/test_translate.py`:

```python
DOC_CFG = {**CFG, "reports_since": "2026-09-01"}


def build_state(root):
    (root / "state").mkdir(parents=True, exist_ok=True)
    (root / "state" / "stance.md").write_text(STANCE_MD, encoding="utf-8")
    (root / "state" / "playbook.md").write_text("Playbook.\n", encoding="utf-8")
    (root / "state" / "watchlist.yaml").write_text(
        yaml.safe_dump({"watchlist": [
            {"theme": "t", "why": "Why.", "since": "2026-08-01"}]}),
        encoding="utf-8")
    (root / "state" / "predictions.jsonl").write_text(
        json.dumps({"id": "p1", "claim": "Claim."}) + "\n", encoding="utf-8")
    reports = root / "reports" / "2026" / "09"
    reports.mkdir(parents=True, exist_ok=True)
    (reports / "2026-09-12-brief.md").write_text("Brief.\n", encoding="utf-8")


def test_translate_docs_covers_every_document_type(tmp_path):
    build_state(tmp_path)
    stats = translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, doc_run())
    assert stats["translated"] >= 6   # 3 stance sections + 3 docs + 1 report
    for rel in ("state/stance.fa.md", "state/playbook.fa.md",
                "state/watchlist.fa.yaml", "state/predictions.fa.jsonl",
                "reports/2026/09/2026-09-12-brief.fa.md"):
        assert (tmp_path / rel).exists(), rel


def test_translate_docs_never_writes_into_an_agent_owned_file(tmp_path):
    """The rule the whole track exists to honour."""
    build_state(tmp_path)
    before = {
        rel: (tmp_path / rel).read_bytes()
        for rel in ("state/stance.md", "state/playbook.md",
                    "state/watchlist.yaml", "state/predictions.jsonl",
                    "reports/2026/09/2026-09-12-brief.md")
    }
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, doc_run())
    for rel, content in before.items():
        assert (tmp_path / rel).read_bytes() == content, rel


def test_translate_docs_is_idempotent(tmp_path):
    build_state(tmp_path)
    translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, doc_run())

    def boom(prompt, schema):
        raise AssertionError("should not have been called")

    assert translate.translate_docs(tmp_path, DOC_CFG, GLOSSARY, boom)["translated"] == 0
```

- [ ] **Step 6: Run it to verify it fails**

Run: `uv run pytest tests/test_translate.py -k translate_docs -v`
Expected: FAIL — `AttributeError: ... has no attribute 'translate_docs'`.

- [ ] **Step 7: Write `translate_docs`**

Append to `jamasp/translate.py`:

```python
def translate_docs(
    root: Path, cfg: dict, glossary: dict, run,
    now: str | None = None, force: bool = False,
) -> dict:
    """Every document sidecar, in one pass. Returns summed counts.

    `root` rather than hard-coded paths so a test can build a whole state tree
    in tmp_path — and so a second checkout is never at risk of writing into the
    live one.
    """
    state, reports = root / "state", root / "reports"
    totals = {"translated": 0, "failed": 0}

    def merge(result):
        totals["translated"] += result["translated"]
        totals["failed"] += result["failed"]

    merge(translate_stance(state / "stance.md", state / "stance.fa.md",
                           glossary, run, now, force=force))
    merge(translate_document(state / "playbook.md", state / "playbook.fa.md",
                             glossary, run, now, force=force))
    merge(translate_watchlist(state / "watchlist.yaml",
                              state / "watchlist.fa.yaml",
                              glossary, run, now, force=force))
    merge(translate_predictions(state / "predictions.jsonl",
                                state / "predictions.fa.jsonl",
                                glossary, run, now, force=force))
    for report in new_reports(reports, cfg["reports_since"]):
        merge(translate_document(
            report, report.with_name(report.name[:-3] + ".fa.md"),
            glossary, run, now, force=force))
    return totals
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `uv run pytest tests/test_translate.py -v`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add jamasp/translate.py tests/test_translate.py
git commit -m "feat(translate): playbook, watchlist, predictions and report sidecars"
```

---

### Task 10: `run_translate`, config validation, and the CLI command

**Files:**
- Modify: `jamasp/translate.py`, `jamasp/cli.py`, `config/settings.yaml`
- Test: `tests/test_translate.py`, `tests/test_cli.py`

**Interfaces:**
- Consumes: every pass above; `modelrun.run_json` (Task 3); `config.load_glossary` (Task 1).
- Produces:
  - `REQUIRED_CFG_KEYS: tuple[str, ...]`
  - `check(cfg: dict) -> str | None` — a human-readable problem, or `None`
  - `run_translate(conn, settings, root=Path("."), glossary=None, run=None, dry_run=False, force=False, only=None) -> dict`
  - CLI command `jamasp translate` with `--dry-run`, `--force`, `--only`, `--check`, `--db`, `--config-dir`

`--only rows` selects the reuse pass *and* the rows pass. The reuse pass is never separately selectable — running rows without it means paying for translations that already exist.

- [ ] **Step 1: Add the config block**

In `config/settings.yaml`, after the `flash:` block:

```yaml
translate:
  # Panel i18n. Deterministic pipeline stage on its own 10-minute timer:
  # consumes no agent-run budget, and never wrapped by `jamasp run`.
  #
  # codex rather than claude because translation is the highest-volume model
  # consumer in the system and must not compete with the agent-run cap or the
  # flash pass for Claude quota. `protocol` picks how the answer is read:
  # 'codex' uses --output-schema/-o files, 'stdout' parses stdout (claude -p).
  cmd: ["codex", "exec", "--ephemeral", "--skip-git-repo-check",
        "--ignore-user-config", "-s", "read-only"]
  protocol: codex
  timeout_seconds: 180
  # Cost knobs. window_days matches the map's widest window; everything older
  # renders English-with-marker in the panel. max_batches_per_run bounds one
  # tick — a larger backlog drains over subsequent ticks, newest first.
  window_days: 7
  batch_size: 20
  max_batches_per_run: 6
  # Spec decision 18: new reports only. Set to the date this shipped.
  reports_since: "2026-09-13"
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/test_translate.py`:

```python
FULL_CFG = {
    "cmd": ["true"], "protocol": "codex", "timeout_seconds": 30,
    "window_days": 7, "batch_size": 20, "max_batches_per_run": 6,
    "reports_since": "2026-09-01",
}


def test_check_reports_a_missing_config_key():
    assert "batch_size" in translate.check({k: v for k, v in FULL_CFG.items()
                                            if k != "batch_size"})


def test_check_reports_an_unknown_protocol():
    assert "protocol" in translate.check({**FULL_CFG, "protocol": "smoke"})


def test_check_reports_a_missing_binary():
    assert "not-a-real-binary-7z1" in translate.check(
        {**FULL_CFG, "cmd": ["not-a-real-binary-7z1"]})


def test_check_passes_on_a_good_config():
    assert translate.check(FULL_CFG) is None


def test_run_translate_dry_run_calls_no_model(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    build_state(tmp_path)

    def boom(prompt, schema):
        raise AssertionError("dry run must not call a model")

    stats = translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=boom, dry_run=True)
    assert stats["pending_rows"] == 1
    assert conn.execute("SELECT headline_fa FROM items").fetchone()[0] is None
    assert not (tmp_path / "state" / "stance.fa.md").exists()


def test_run_translate_only_rows_skips_documents(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    build_state(tmp_path)
    translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=fake_run(), only="rows")
    assert conn.execute("SELECT headline_fa FROM items").fetchone()[0] is not None
    assert not (tmp_path / "state" / "stance.fa.md").exists()


def test_run_translate_only_rows_still_runs_the_reuse_pass(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("One", 1)])
    add_flash(conn, one)
    calls = []
    translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY,
        run=fake_run(calls=calls), only="rows")
    assert calls == []   # the flash Persian covered it; no model call
    assert conn.execute("SELECT fa_source FROM items").fetchone()[0] == "flash"


def test_run_translate_reports_every_pass(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("One", 1)])
    build_state(tmp_path)
    stats = translate.run_translate(
        conn, {"translate": {**FULL_CFG, "reports_since": "2026-09-01"}},
        root=tmp_path, glossary=GLOSSARY, run=fake_run())
    for key in ("reused", "rows", "events", "docs"):
        assert key in stats
```

`fake_run` (defined in Task 5) already answers both prompt shapes, so these tests need no new helper.

- [ ] **Step 3: Run them to verify they fail**

Run: `uv run pytest tests/test_translate.py -k "check or run_translate" -v`
Expected: FAIL — `AttributeError: ... has no attribute 'check'`.

- [ ] **Step 4: Write `check` and `run_translate`**

Append to `jamasp/translate.py` (add `import shutil`):

```python
REQUIRED_CFG_KEYS = (
    "cmd", "protocol", "timeout_seconds",
    "window_days", "batch_size", "max_batches_per_run", "reports_since",
)


def check(cfg: dict) -> str | None:
    """Preflight: config complete, protocol known, binary present.

    The codex analogue of the Claude credentials trap in CLAUDE.md. A run whose
    auth has lapsed fails every batch identically while still exiting zero, so
    an operator needs a way to ask "is this even wired up?" that does not
    involve reading the journal.
    """
    missing = [k for k in REQUIRED_CFG_KEYS if k not in cfg]
    if missing:
        return f"settings.yaml translate: missing {', '.join(missing)}"
    if cfg["protocol"] not in modelrun.PROTOCOLS:
        return (f"settings.yaml translate.protocol {cfg['protocol']!r} unknown;"
                f" expected one of {modelrun.PROTOCOLS}")
    binary = (cfg["cmd"] or [""])[0]
    if not binary or shutil.which(binary) is None:
        return (f"translator {binary!r} is not on PATH —"
                " install it, or point translate.cmd elsewhere")
    return None


def run_translate(
    conn: sqlite3.Connection, settings: dict, root: Path = Path("."),
    glossary: dict | None = None, run=None, now: str | None = None,
    dry_run: bool = False, force: bool = False, only: str | None = None,
) -> dict:
    """One full pass. Returns per-pass counts for the CLI to print."""
    cfg = settings["translate"]
    if glossary is None:
        glossary = config_mod.load_glossary()
    if run is None:
        def run(prompt, schema):
            return modelrun.run_json(
                cfg["cmd"], cfg["protocol"], prompt, schema,
                cfg["timeout_seconds"])

    want_rows = only in (None, "rows")
    want_events = only in (None, "events")
    want_docs = only in (None, "docs")

    if dry_run:
        return {
            "dry_run": True,
            "pending_rows": len(pending_rows(
                conn, cfg["window_days"], cfg["batch_size"] * cfg["max_batches_per_run"], now)),
            "pending_events": len(pending_events(
                conn, cfg["window_days"], cfg["batch_size"] * cfg["max_batches_per_run"], now)),
            "pending_reports": len(new_reports(root / "reports", cfg["reports_since"])),
        }

    stats: dict = {"reused": 0, "rows": {}, "events": {}, "docs": {}}
    if want_rows:
        # Always before the model pass, and not separately selectable: a rows
        # pass that ran first would pay to translate what flash already wrote.
        stats["reused"] = reuse_flash_persian(conn, now)
        stats["rows"] = translate_rows(conn, cfg, glossary, run, now)
    if want_events:
        stats["events"] = translate_events(conn, cfg, glossary, run, now)
    if want_docs:
        stats["docs"] = translate_docs(root, cfg, glossary, run, now, force)
    return stats
```

Add `from jamasp import config as config_mod` to the imports.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_translate.py -v`
Expected: PASS.

- [ ] **Step 6: Write the failing CLI test**

Append to `tests/test_cli.py`, following the existing `CliRunner` pattern in that file:

```python
def test_translate_dry_run_reports_pending_and_writes_nothing(tmp_path, monkeypatch):
    db_path = tmp_path / "t.db"
    conn = db.connect(db_path)
    conn.execute(
        "INSERT INTO items (id, source, published_at, headline, url, topic,"
        " fetched_at) VALUES ('i1','a',?,'Gold climbs','https://e/1','gold',?)",
        (utcnow(), utcnow()),
    )
    conn.commit()
    conn.close()

    result = CliRunner().invoke(
        cli.main,
        ["translate", "--dry-run", "--db", str(db_path), "--config-dir", "config"],
    )
    assert result.exit_code == 0, result.output
    assert "1 row" in result.output

    conn = db.connect(db_path)
    assert conn.execute("SELECT headline_fa FROM items").fetchone()[0] is None


def test_translate_check_reports_a_broken_translator(tmp_path):
    cfgdir = tmp_path / "config"
    cfgdir.mkdir()
    (cfgdir / "sources.yaml").write_text(
        Path("config/sources.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    (cfgdir / "glossary.fa.yaml").write_text("Fed: فدرال رزرو\n", encoding="utf-8")
    settings = yaml.safe_load(Path("config/settings.yaml").read_text(encoding="utf-8"))
    settings["translate"]["cmd"] = ["not-a-real-binary-7z1"]
    (cfgdir / "settings.yaml").write_text(
        yaml.safe_dump(settings, allow_unicode=True), encoding="utf-8")

    result = CliRunner().invoke(
        cli.main,
        ["translate", "--check", "--db", str(tmp_path / "t.db"),
         "--config-dir", str(cfgdir)],
    )
    assert result.exit_code != 0
    assert "not-a-real-binary-7z1" in result.output
```

Check the imports at the top of `tests/test_cli.py` — add `yaml` and `utcnow` if they are not already there.

- [ ] **Step 7: Run it to verify it fails**

Run: `uv run pytest tests/test_cli.py -k translate -v`
Expected: FAIL — `Error: No such command 'translate'`.

- [ ] **Step 8: Add the CLI command**

In `jamasp/cli.py`, after the `flash_rollup` command, and adding
`from jamasp import translate as translate_mod` to the imports:

```python
def _translate_line(stats: dict) -> str:
    """One-line summary of a translate pass."""
    if stats.get("dry_run"):
        return (f"dry run: {stats['pending_rows']} rows,"
                f" {stats['pending_events']} events,"
                f" {stats['pending_reports']} reports pending")
    rows, events, docs = stats["rows"], stats["events"], stats["docs"]
    return (
        f"reused {stats['reused']}; "
        f"rows {rows.get('translated', 0)}/{rows.get('failed', 0)} in"
        f" {rows.get('batches', 0)} batches; "
        f"events {events.get('translated', 0)}/{events.get('failed', 0)}; "
        f"docs {docs.get('translated', 0)}/{docs.get('failed', 0)}"
    )


@main.command()
@click.option("--dry-run", is_flag=True, help="report what would be translated")
@click.option("--force", is_flag=True, help="retranslate even when unchanged")
@click.option("--only", type=click.Choice(["rows", "events", "docs"]),
              help="run one track (rows always includes the flash reuse pass)")
@click.option("--check", "check_only", is_flag=True,
              help="verify the translator is installed and configured")
@db_opt
@cfg_opt
def translate(dry_run, force, only, check_only, db_path, config_dir):
    """Fill Persian renderings of everything the panel renders."""
    conn, _, settings = _common(db_path, config_dir)
    problem = translate_mod.check(settings["translate"])
    if check_only:
        if problem:
            raise click.ClickException(problem)
        click.echo("translate: ok")
        return
    if problem and not dry_run:
        raise click.ClickException(problem)
    stats = translate_mod.run_translate(
        conn,
        settings,
        glossary=load_glossary(Path(config_dir) / "glossary.fa.yaml"),
        dry_run=dry_run,
        force=force,
        only=only,
    )
    click.echo(_translate_line(stats))
```

Add `load_glossary` to the existing `from jamasp.config import ...` line.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `uv run pytest tests/test_cli.py -k translate -v && uv run pytest -q`
Expected: PASS, and the whole suite green.

- [ ] **Step 10: Commit**

```bash
git add jamasp/translate.py jamasp/cli.py config/settings.yaml tests/test_translate.py tests/test_cli.py
git commit -m "feat(translate): jamasp translate command and preflight check"
```

---

### Task 11: The watchdog backlog probe

**Files:**
- Modify: `jamasp/watchdog.py` (constants near the top, and `check` at line 127)
- Test: `tests/test_watchdog.py`

**Interfaces:**
- Consumes: `translate.MAX_ATTEMPTS`, `translate.pending_rows` semantics (Task 5).
- Produces: two new violation strings from `watchdog.check`.

A timer that runs successfully while translating nothing is the failure mode the unit-level `OnFailure` alert cannot see — a run whose every batch fails still exits zero.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_watchdog.py`, matching that file's existing fixture style:

```python
def test_translate_backlog_violation_when_rows_sit_untranslated(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    stamp = "2026-09-13T12:00:00Z"
    conn.execute(
        "INSERT INTO items (id, source, published_at, headline, url, topic,"
        " fetched_at) VALUES ('i1','a','2026-09-13T10:00:00Z','H',"
        " 'https://e/1','gold','2026-09-13T10:00:00Z')"
    )
    conn.commit()
    violations = watchdog.check(conn, tmp_path, now=stamp,
                                credentials_path=tmp_path / "none.json")
    assert any("translate backlog" in v for v in violations)


def test_no_translate_violation_for_a_freshly_arrived_row(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    conn.execute(
        "INSERT INTO items (id, source, published_at, headline, url, topic,"
        " fetched_at) VALUES ('i1','a','2026-09-13T11:50:00Z','H',"
        " 'https://e/1','gold','2026-09-13T11:50:00Z')"
    )
    conn.commit()
    violations = watchdog.check(conn, tmp_path, now="2026-09-13T12:00:00Z",
                                credentials_path=tmp_path / "none.json")
    assert not any("translate backlog" in v for v in violations)


def test_no_translate_violation_when_the_row_is_translated(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    conn.execute(
        "INSERT INTO items (id, source, published_at, headline, headline_fa,"
        " url, topic, fetched_at) VALUES ('i1','a','2026-09-13T10:00:00Z','H',"
        " 'تیتر','https://e/1','gold','2026-09-13T10:00:00Z')"
    )
    conn.commit()
    violations = watchdog.check(conn, tmp_path, now="2026-09-13T12:00:00Z",
                                credentials_path=tmp_path / "none.json")
    assert not any("translate backlog" in v for v in violations)


def test_abandoned_rows_are_reported_separately(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    conn.execute(
        "INSERT INTO items (id, source, published_at, headline, url, topic,"
        " fetched_at, fa_attempts) VALUES ('i1','a','2026-09-13T11:55:00Z','H',"
        " 'https://e/1','gold','2026-09-13T11:55:00Z', 3)"
    )
    conn.commit()
    violations = watchdog.check(conn, tmp_path, now="2026-09-13T12:00:00Z",
                                credentials_path=tmp_path / "none.json")
    assert any("gave up" in v for v in violations)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_watchdog.py -k translate -v`
Expected: FAIL — no violation containing "translate backlog".

- [ ] **Step 3: Add the probe**

`watchdog.py` imports `jamasp.db` only, and `translate.py` imports `config`, `db`, `modelrun` and `translatetext` — none of which import `watchdog`. So there is no cycle: import the constant rather than duplicating the number.

In `jamasp/watchdog.py`, add `from jamasp import translate as translate_mod` to the imports, then add near the other constants:

```python
# A row inside the panel's window that is still untranslated this long after
# publication means the 10-minute translate timer is not doing its job. Six
# ticks of slack: a backlog drains newest-first, so a burst of news can
# legitimately leave an older row waiting for a few ticks.
TRANSLATE_BACKLOG_MINUTES = 45
_TRANSLATE = "check jamasp-translate.service and `jamasp translate --check`"
```

And inside `check`, before `return violations`:

```python
    # A translate run whose every batch fails still exits zero, so the unit's
    # OnFailure alert cannot see it. Backlog is the signal that can.
    threshold = (now_dt - timedelta(minutes=TRANSLATE_BACKLOG_MINUTES)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    backlog = conn.execute(
        "SELECT COUNT(*) FROM items"
        " WHERE headline_fa IS NULL AND fa_attempts < ? AND published_at < ?",
        (translate_mod.MAX_ATTEMPTS, threshold),
    ).fetchone()[0]
    if backlog:
        violations.append(
            f"translate backlog: {backlog} items untranslated"
            f" > {TRANSLATE_BACKLOG_MINUTES} min after publication; {_TRANSLATE}")

    abandoned = conn.execute(
        "SELECT COUNT(*) FROM items"
        " WHERE headline_fa IS NULL AND fa_attempts >= ?",
        (translate_mod.MAX_ATTEMPTS,),
    ).fetchone()[0]
    if abandoned:
        violations.append(
            f"translate gave up on {abandoned} items after"
            f" {translate_mod.MAX_ATTEMPTS} attempts; {_TRANSLATE}")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_watchdog.py -v`
Expected: PASS, including the pre-existing watchdog tests.

- [ ] **Step 5: Commit**

```bash
git add jamasp/watchdog.py tests/test_watchdog.py
git commit -m "feat(translate): watchdog probe for an untranslated backlog"
```

---

### Task 12: Wire the glossary into the flash prompts

**Files:**
- Modify: `jamasp/flashtext.py` (`build_write_prompt`, `build_rollup_prompt`)
- Modify: `jamasp/flash.py` (the two call sites, at lines 274 and 674)
- Test: `tests/test_flashtext.py`, `tests/test_flash.py`

**Interfaces:**
- Consumes: `translatetext.glossary_block` (Task 2), `config.load_glossary` (Task 1).
- Produces: `build_write_prompt(..., glossary: Mapping[str, str] | None = None)` and `build_rollup_prompt(items, glossary: Mapping[str, str] | None = None)`.

This is the whole argument for the glossary being a file rather than a paragraph inside the translate prompt: the panel and the Telegram news channel must not settle on two different Persian words for the same thing. The parameter defaults to `None` so every existing call site and test keeps working unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_flashtext.py`:

```python
def test_write_prompt_carries_the_glossary_when_given():
    prompt = flashtext.build_write_prompt(
        "Fed holds rates", "Reuters", "2026-09-13T10:00:00Z", "Body.",
        glossary={"Fed": "فدرال رزرو"},
    )
    assert "فدرال رزرو" in prompt


def test_write_prompt_without_a_glossary_is_unchanged():
    args = ("Fed holds rates", "Reuters", "2026-09-13T10:00:00Z", "Body.")
    assert flashtext.build_write_prompt(*args) == flashtext.build_write_prompt(
        *args, glossary=None)


def test_write_prompt_keeps_the_glossary_outside_the_article_fence():
    """Our instructions must never sit inside the untrusted-text fence."""
    prompt = flashtext.build_write_prompt(
        "H", "S", "2026-09-13T10:00:00Z", "Body.",
        glossary={"Fed": "فدرال رزرو"},
    )
    fence_start = prompt.index(flashtext.ARTICLE_OPEN)
    assert prompt.index("فدرال رزرو") < fence_start


def test_rollup_prompt_carries_the_glossary():
    items = [{"title_fa": "تیتر", "url": "https://e/1"}]
    prompt = flashtext.build_rollup_prompt(items, glossary={"Fed": "فدرال رزرو"})
    assert "فدرال رزرو" in prompt
```

Check `test_flashtext.py`'s existing import line and the real argument order of `build_rollup_prompt` before writing these — adjust the item dict to whatever that function actually reads.

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_flashtext.py -k glossary -v`
Expected: FAIL with `TypeError: build_write_prompt() got an unexpected keyword argument 'glossary'`.

- [ ] **Step 3: Add the parameter**

In `jamasp/flashtext.py`, import the shared renderer at the top:

```python
from jamasp.translatetext import glossary_block
```

Then add the parameter to `build_write_prompt`, placing the block **before** `ARTICLE_OPEN` so our instructions stay outside the untrusted-text fence:

```python
def build_write_prompt(
    headline: str,
    source_label: str,
    published_at: str,
    body: str,
    lede: str | None = None,
    glossary: Mapping[str, str] | None = None,
) -> str:
```

and inside it, after the `preamble`/`fenced` branch:

```python
    # Outside the fence, with our other instructions: the glossary is ours,
    # not the article's. Shared with `jamasp translate` so the channel and the
    # panel cannot settle on two different Persian words for the same term.
    terms = f"{glossary_block(glossary)}\n\n" if glossary else ""
```

and add `{terms}` to the returned f-string immediately before `{ARTICLE_OPEN}`:

```python
    return (
        f"{WRITE_HEADER}HEADLINE: {_one_line(headline)}\n"
        f"SOURCE: {_one_line(source_label)}\n"
        f"PUBLISHED: {_one_line(published_at)}\n\n"
        f"{preamble}{SOURCE_CAUTION}\n\n"
        f"{terms}"
        f"{ARTICLE_OPEN}\n{fenced}\n{ARTICLE_CLOSE}\n"
    )
```

Apply the same `glossary: Mapping[str, str] | None = None` parameter and `terms` prefix to `build_rollup_prompt`.

Add `Mapping` to the `typing` import if it is not already there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_flashtext.py -v`
Expected: PASS, including every pre-existing flashtext test — the default `None` keeps them byte-identical.

- [ ] **Step 5: Pass the glossary from the flash pass**

In `jamasp/flash.py`, load it once per run and thread it to both call sites. Find where `cfg` is unpacked in `run_flash` and add:

```python
    glossary = config_mod.load_glossary()
```

`flash.py` already imports `config as config_mod`. Then at the `build_write_prompt` call (line 274) add `glossary=glossary`, and likewise at the `build_rollup_prompt` call (line 674).

- [ ] **Step 6: Add a test proving the flash pass threads it through**

Append to `tests/test_flash.py`. This reuses that file's existing `seed`, `SETTINGS`, `SOURCES`, `FakePoster` and `no_extract` helpers, and its `run_model` injection point — the `model()` helper returns a `run(cmd, prompt)` callable, so capturing prompts means writing one in the same shape:

```python
def test_run_flash_glosses_the_write_prompt(tmp_path, monkeypatch):
    """The channel and the panel must gloss terms the same way."""
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Fed holds rates steady", 1)])
    seen = []

    def capturing(cmd, prompt):
        seen.append((cmd, prompt))
        if cmd == ["fake-decide"]:
            return json.dumps({one: {"gold": True, "dup_of": None}})
        return json.dumps(
            {"title_fa": "عنوان", "summary_fa": "خلاصه", "impact_fa": "اثر"})

    flash.run_flash(conn, SETTINGS, SOURCES, post=FakePoster(),
                    run_model=capturing)

    write_prompts = [p for cmd, p in seen if cmd == ["fake-write"]]
    assert write_prompts, "the write model was never called"
    assert any("فدرال رزرو" in p for p in write_prompts)
```

This test reads the real `config/glossary.fa.yaml` through `run_flash`, so it also proves the shipped file actually contains the `Fed` entry the assertion depends on.

- [ ] **Step 7: Run the full suite**

Run: `uv run pytest -q`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add jamasp/flashtext.py jamasp/flash.py tests/test_flashtext.py tests/test_flash.py
git commit -m "feat(flash): gloss channel prompts from the shared glossary"
```

---

### Task 13: Systemd units and documentation

**Files:**
- Create: `ops/systemd/jamasp-translate.service`, `ops/systemd/jamasp-translate.timer`
- Modify: `CLAUDE.md` (the Toolbox table and the Deployment section), `.claude/skills/deploy/SKILL.md`
- Test: manual verification steps below; no automated test

**Interfaces:**
- Consumes: the `jamasp translate` command (Task 10).
- Produces: nothing other code depends on.

- [ ] **Step 1: Write the service unit**

Create `ops/systemd/jamasp-translate.service`, modelled on `jamasp-flash-rollup.service`:

```ini
[Unit]
Description=Jamasp panel i18n — fill Persian renderings for the panel
OnFailure=jamasp-alert@%n.service

[Service]
Type=oneshot
WorkingDirectory=%h/Jamasp
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.config/jamasp/env
# Deterministic pipeline stage, not an agent run: no `jamasp run` wrapper, so
# it consumes none of the daily agent-run cap — same as flash and rollup.
#
# A run whose every batch fails still exits zero, so this unit's OnFailure
# alert is not the whole story: `jamasp watchdog` carries the backlog probe.
ExecStart=%h/.local/bin/uv run jamasp translate
```

- [ ] **Step 2: Write the timer unit**

Create `ops/systemd/jamasp-translate.timer`:

```ini
[Unit]
Description=Run the Jamasp translate pass every 10 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
# OnUnitActiveSec rather than OnCalendar so a slow pass cannot stack against
# the next tick: the interval is measured from the end of the last run.

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Verify the units parse**

Run: `systemd-analyze verify ops/systemd/jamasp-translate.service 2>&1 | head`
Expected: no output, or only warnings about `%h` outside a user manager. On macOS `systemd-analyze` is absent — skip this step locally and verify on the host during deploy.

- [ ] **Step 4: Update the CLAUDE.md toolbox table**

In the Toolbox table in `CLAUDE.md`, after the `jamasp flash-rollup` row:

```markdown
| `uv run jamasp translate` | fill Persian renderings for the panel (own timer, 10-min) |
```

- [ ] **Step 5: Update the CLAUDE.md deployment section**

In the Deployment section, change "eight systemd timers" to "nine systemd timers" and add the new timer to the list. Then add this paragraph after the one describing the news channel:

```markdown
A separate 10-minute `translate` timer fills the Persian the panel renders:
`_fa` columns on `items` and `events`, and `.fa` sidecars beside the documents
agent runs write. It reuses the Persian the flash pass already produced before
calling a model, translates through `codex` rather than Claude so it never
competes for the agent-run budget, and — like flash — is a deterministic
pipeline stage needing no supervision. Reports and state files stay English:
translation is presentation only, and no analysis run ever reads Persian.
```

- [ ] **Step 6: Update the deploy skill**

In `.claude/skills/deploy/SKILL.md`, alongside the existing step that copies Claude's `~/.claude/.credentials.json`, add:

```markdown
### codex credentials (for `jamasp translate`)

The translate timer shells out to `codex exec`. Authenticate it **as the
`jamasp` service user**, not as root:

```bash
su - jamasp -c 'codex login'
```

Then verify the whole path before enabling the timer:

```bash
su - jamasp -c 'cd ~/Jamasp && uv run jamasp translate --check'
```

Same trap as Claude's credentials: an interactive login as the wrong user
leaves the service user unauthenticated, and a `codex exec` with lapsed auth
fails every batch while still exiting zero — so the unit's `OnFailure` alert
stays silent. `--check` is what catches it; `jamasp watchdog`'s backlog probe
is what catches it later.
```

Place it under the existing `## Human handoff (two steps, then activate)` section (around line 184), where the Claude credentials step already lives. `###` is the correct level there.

- [ ] **Step 7: Enable and verify on the host**

Per memory, `ssh jamasp` lands as root — `su - jamasp` before running anything, and the host runs a `live` branch updated by `git merge origin/main`.

```bash
# as root
cp ops/systemd/jamasp-translate.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now jamasp-translate.timer
systemctl list-timers jamasp-translate.timer
```

Then measure before trusting the ceiling — this is the spec's open cost
question:

```bash
su - jamasp -c "sqlite3 ~/Jamasp/state/jamasp.db \
  \"SELECT COUNT(*) AS in_window,
      SUM(CASE WHEN headline_fa IS NOT NULL THEN 1 ELSE 0 END) AS already_fa
    FROM items WHERE published_at >= datetime('now','-7 days');\""
```

If `in_window - already_fa` divided by `batch_size` exceeds
`max_batches_per_run` by more than a few ticks' worth, raise the ceiling or add
a tier floor as the spec's Risks section describes. Record the measured numbers
in the PR description.

- [ ] **Step 8: Commit**

```bash
git add ops/systemd/jamasp-translate.service ops/systemd/jamasp-translate.timer CLAUDE.md .claude/skills/deploy/SKILL.md
git commit -m "feat(translate): systemd timer, runbook and toolbox entry"
```

- [ ] **Step 9: Run the full suite one last time**

Run: `uv run pytest -q`
Expected: all green. Do not open the PR on a red suite.

---

## Verification before the PR

Run all of these and paste the output into the PR description:

```bash
uv run pytest -q
uv run jamasp translate --check
uv run jamasp translate --dry-run
git diff --stat main...HEAD -- panel/     # must be EMPTY: panel ships in PR 2
```

The last command is the one worth being pedantic about. This PR is the job and
nothing else; a stray panel change here is the seam where "English default
until the backlog is full" stops meaning anything.
