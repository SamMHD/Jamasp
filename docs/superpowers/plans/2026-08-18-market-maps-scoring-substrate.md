# Market Maps — Scoring Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jamasp record, for every gold-relevant news item, the direction and conviction of its likely effect on gold alongside the tier it already records — and widen the TradingView feed to the full signal set — so the training data the market maps need starts accumulating today.

**Architecture:** No new pipeline stage and no new model call. The batched triage call in `jamasp/flash.py` already reads every candidate's headline and lede once per ingest tick and returns `{gold, dup_of, tier}`; it gains `direction`, `conviction` and `theme`, and the verdicts are persisted to a new `item_scores` table independently of what the flash delivery loop does with each item. Separately, the existing `tv_gc_technicals` source's field list is widened to ~51 series across three timeframes, which is a config and lookup-table change with no new code path.

**Tech Stack:** Python 3.12, sqlite3 (stdlib), pyyaml, httpx, pytest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-market-maps-design.md`

## Global Constraints

- **No new runtime dependencies.** The project's deps are click, httpx[socks], feedparser, trafilatura, rapidfuzz, pyyaml, pyjwt[crypto]. numpy arrives in Plan 2 for the ridge fit, not here.
- **`direction` is gold-relative, never sentiment.** A strong-dollar print is `-2` even though it is good news for the dollar. This must be stated in the prompt and asserted in a test.
- **Never `ALTER` an existing table in `SCHEMA`.** The live database is months of history that cannot be recreated. `SCHEMA` is all `CREATE TABLE IF NOT EXISTS`; column additions to existing tables go through `db.ADDED_COLUMNS` (`jamasp/db.py:113`).
- **`sources.yaml:279` stands:** TradingView's `Recommend.All` / `Recommend.MA` / `Recommend.Other` aggregate gauges are **not** to be added to the field list. Neither map produces an aggregate verdict.
- **The theme taxonomy has exactly one home:** `config/weights.yaml`. It must not be duplicated as a constant in `flashtext.py`, and the prompt text is built from the loaded list.
- **Tests run with:** `uv run pytest`

---

### Task 1: Probe Yahoo's intraday history depth (spike)

This is a **spike**, not production code. Its only output is a recorded finding, because Plan 2 cannot be written without it: if Yahoo serves enough hourly history to resample 4h bars, the 4h signals ship with fitted weights; if not, they start at 1.0 and render with the dashed "not yet fitted" outline. Nothing built here is kept.

**Files:**
- Create (throwaway): `/tmp/probe_yahoo.py`
- Modify: `docs/superpowers/specs/2026-08-18-market-maps-design.md` (the "Open empirical question" paragraph in §3)

**Interfaces:**
- Consumes: nothing
- Produces: a recorded fact only — no code any later task imports

- [ ] **Step 1: Write the probe script**

```python
# /tmp/probe_yahoo.py — throwaway. Asks Yahoo how far back GC=F goes at each
# interval. Only the bar counts and date ranges matter.
import httpx

URL = "https://query1.finance.yahoo.com/v8/finance/chart/GC=F"
HEADERS = {"User-Agent": "Mozilla/5.0"}

for rng, interval in [
    ("5y", "1d"), ("2y", "1d"),
    ("730d", "1h"), ("2y", "1h"), ("60d", "1h"), ("1mo", "1h"),
]:
    try:
        r = httpx.get(URL, params={"range": rng, "interval": interval},
                      headers=HEADERS, timeout=30)
        result = r.json()["chart"]["result"]
        if not result:
            print(f"{rng:6} {interval:3}  EMPTY")
            continue
        ts = result[0]["timestamp"]
        print(f"{rng:6} {interval:3}  {len(ts):6} bars  "
              f"first={ts[0]}  last={ts[-1]}")
    except Exception as exc:
        print(f"{rng:6} {interval:3}  ERROR {type(exc).__name__}: {exc}")
```

- [ ] **Step 2: Run it**

Run: `uv run python /tmp/probe_yahoo.py`

Expected: one line per range/interval pair. The number that decides Plan 2 is the **bar count for the deepest working `1h` request**. Roughly 3,000+ hourly bars resamples to ~750 4h bars, which is enough to fit; a few hundred is not.

- [ ] **Step 3: Record the finding in the spec**

Replace the "**Open empirical question:**" paragraph in §3 "Backfill" of `docs/superpowers/specs/2026-08-18-market-maps-design.md` with the measured result. Write the actual numbers, e.g.:

```markdown
**Measured 2026-08-18:** Yahoo serves GC=F at `range=730d&interval=1h` →
N bars (first YYYY-MM-DD), resampling to M 4h bars. The 4h signals
therefore ship [fitted | at 1.0 and warming up], rendered [solid | dashed]
per the confidence treatment of §2.
```

If every `1h` request fails or returns a few hundred bars, say exactly that — a negative result is the finding, and the design already handles it.

- [ ] **Step 4: Delete the probe and commit the spec update**

```bash
rm /tmp/probe_yahoo.py
git add docs/superpowers/specs/2026-08-18-market-maps-design.md
git commit -m "docs(spec): record measured Yahoo intraday depth for 4h backfill"
```

---

### Task 2: `item_scores` table

**Files:**
- Modify: `jamasp/db.py` (append to `SCHEMA`, the string ending at `jamasp/db.py:106`)
- Test: `tests/test_db.py`

**Interfaces:**
- Consumes: `db.connect(path) -> sqlite3.Connection` (existing)
- Produces: table `item_scores(item_id TEXT PK, tier INTEGER, direction INTEGER, conviction REAL, theme TEXT, scored_at TEXT)`, created by `db.connect`. Task 5 writes to it; Plan 3 reads it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_db.py`:

```python
def test_connect_creates_item_scores(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    tables = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert "item_scores" in tables


def test_item_scores_columns(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(item_scores)")}
    assert cols == {"item_id", "tier", "direction", "conviction",
                    "theme", "scored_at"}


def test_item_scores_one_row_per_item(tmp_path):
    # Re-scoring an item must replace its row, not accumulate rows: the map
    # reads the current verdict, and a duplicate would double the tile's area.
    conn = db.connect(tmp_path / "t.db")
    for tier in (3, 5):
        conn.execute(
            "INSERT OR REPLACE INTO item_scores"
            " (item_id, tier, direction, conviction, theme, scored_at)"
            " VALUES ('a', ?, 1, 0.5, 'rates_dollar', '2026-08-18T00:00:00Z')",
            (tier,),
        )
    conn.commit()
    rows = conn.execute("SELECT tier FROM item_scores").fetchall()
    assert [r["tier"] for r in rows] == [5]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_db.py -k item_scores -v`
Expected: FAIL — `sqlite3.OperationalError: no such table: item_scores`

- [ ] **Step 3: Add the table to `SCHEMA`**

In `jamasp/db.py`, inside the `SCHEMA` string, immediately before the closing `"""`:

```sql
CREATE TABLE IF NOT EXISTS item_scores (
    item_id    TEXT PRIMARY KEY REFERENCES items(id),
    tier       INTEGER NOT NULL,
    direction  INTEGER NOT NULL,
    conviction REAL    NOT NULL,
    theme      TEXT    NOT NULL,
    scored_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_scores_theme ON item_scores(theme);
```

Do **not** add anything to `ADDED_COLUMNS` — this is a new table, and `CREATE TABLE IF NOT EXISTS` is safe against the live database.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_db.py -v`
Expected: PASS, including the pre-existing `test_connect_is_idempotent`.

- [ ] **Step 5: Commit**

```bash
git add jamasp/db.py tests/test_db.py
git commit -m "feat(db): item_scores table for market-map news scoring"
```

---

### Task 3: Theme taxonomy in config

**Files:**
- Create: `config/weights.yaml`
- Modify: `jamasp/config.py`
- Test: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing
- Produces: `config.load_weights(path: Path = Path("config/weights.yaml")) -> dict` and `config.themes(weights: dict) -> tuple[str, ...]`. Task 4 calls `themes()` to build the prompt and validate model output; Plan 2 extends `weights.yaml` with the horizon, ridge alpha and pins.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_config.py`:

```python
from pathlib import Path

from jamasp import config


def test_load_weights_reads_themes(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text("themes:\n  - rates_dollar\n  - geopolitics\n  - other\n")
    assert config.themes(config.load_weights(p)) == (
        "rates_dollar", "geopolitics", "other")


def test_themes_order_is_preserved(tmp_path):
    # The ridge fit in Plan 2 indexes feature columns by this order, so it is
    # data, not presentation. Sorting it here would silently permute the
    # fitted coefficients against their labels.
    p = tmp_path / "w.yaml"
    p.write_text("themes:\n  - zulu\n  - alpha\n  - other\n")
    assert config.themes(config.load_weights(p)) == ("zulu", "alpha", "other")


def test_shipped_weights_config_has_other_as_the_fallback_slot():
    # Task 4 falls back to "other" for any theme the model invents, so the
    # slot must exist in the shipped taxonomy or those items land nowhere.
    weights = config.load_weights(Path("config/weights.yaml"))
    assert "other" in config.themes(weights)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_config.py -k "weights or themes" -v`
Expected: FAIL with `AttributeError: module 'jamasp.config' has no attribute 'load_weights'`

- [ ] **Step 3: Create `config/weights.yaml`**

```yaml
# Market-map weighting. Owned by the weekly retro (intent); the daily fit
# writes its measurements to state/weights.json instead, so a diff of this
# file is always a deliberate change.
#
# themes: the fundamental map's taxonomy. This is a FIXED list because the
# ridge fit indexes its feature columns by position — adding, removing or
# reordering a slot invalidates the fitted coefficients and must trigger a
# refit from history. "other" is the fallback slot for anything the triage
# model names that is not on this list; it must always be present.
themes:
  - rates_dollar
  - geopolitics
  - physical_cb
  - etf_flows
  - supply_mining
  - other
```

- [ ] **Step 4: Add the loader to `jamasp/config.py`**

Append to `jamasp/config.py`:

```python
def load_weights(path: Path = Path("config/weights.yaml")) -> dict:
    return yaml.safe_load(path.read_text())


def themes(weights: dict) -> tuple[str, ...]:
    """The fundamental map's theme slots, in configured order.

    Order is data, not presentation: Plan 2's fit indexes its feature columns
    by position, so sorting or de-duplicating here would permute fitted
    coefficients against their labels.
    """
    return tuple(weights["themes"])
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_config.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add config/weights.yaml jamasp/config.py tests/test_config.py
git commit -m "feat(config): theme taxonomy for the fundamental market map"
```

---

### Task 4: `direction`, `conviction` and `theme` in the triage call

**Files:**
- Modify: `jamasp/flashtext.py` (`DECIDE_HEADER` at line 18, `build_decide_prompt`, `parse_decide_response` at line 171)
- Test: `tests/test_flashtext.py`

**Interfaces:**
- Consumes: `config.themes(...) -> tuple[str, ...]` (Task 3)
- Produces:
  - `flashtext.build_decide_prompt(posted, candidates, themes: Sequence[str]) -> str` — **the `themes` parameter is new and required**
  - `flashtext.parse_decide_response(text: str, themes: Sequence[str]) -> dict[str, dict]` — **`themes` is new and required**; each verdict dict gains `"direction": int | None`, `"conviction": float | None`, `"theme": str`
- Task 5 consumes both.

**Note on churn:** `parse_decide_response` has 6 call sites in `tests/test_flashtext.py` (lines 46, 53, 60, 223, 232, 237) and 1 in `jamasp/flash.py:373`; `build_decide_prompt` has call sites in the same two files. All must gain the `themes` argument. Making it required rather than defaulted is deliberate: a default would silently route every item to `"other"` if a caller forgot it, and the taxonomy has exactly one home.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_flashtext.py`:

```python
THEMES = ("rates_dollar", "geopolitics", "physical_cb",
          "etf_flows", "supply_mining", "other")


def test_decide_prompt_asks_for_gold_relative_direction():
    prompt = flashtext.build_decide_prompt(
        [], [{"id": "a", "source": "s", "headline": "h", "lede": None}], THEMES)
    assert '"direction"' in prompt
    # The single most important instruction in the addition: without it the
    # model scores sentiment and a strong-dollar print comes back positive.
    assert "dollar" in prompt.lower()
    assert "-2" in prompt and "+2" in prompt


def test_decide_prompt_lists_the_configured_themes():
    prompt = flashtext.build_decide_prompt(
        [], [{"id": "a", "source": "s", "headline": "h", "lede": None}],
        ("alpha", "bravo", "other"))
    assert "alpha, bravo, other" in prompt
    # The taxonomy has one home; a hardcoded slot leaking into the prompt
    # would drift from config the first time the retro edits it.
    assert "rates_dollar" not in prompt


def test_parse_decide_response_reads_direction_conviction_and_theme():
    out = flashtext.parse_decide_response(
        '{"a": {"gold": true, "dup_of": null, "tier": 5,'
        ' "direction": -2, "conviction": 0.8, "theme": "rates_dollar"}}',
        THEMES)
    assert out["a"]["direction"] == -2
    assert out["a"]["conviction"] == 0.8
    assert out["a"]["theme"] == "rates_dollar"


def test_parse_decide_response_absent_direction_is_none():
    # None is a real answer, matching _tier: the caller decides what an
    # unscored item does, and 0 would be a fabricated "neutral" claim.
    out = flashtext.parse_decide_response(
        '{"a": {"gold": true, "tier": 3}}', THEMES)
    assert out["a"]["direction"] is None
    assert out["a"]["conviction"] is None


def test_parse_decide_response_rejects_out_of_range_direction():
    out = flashtext.parse_decide_response(
        '{"a": {"gold": true, "tier": 3, "direction": 7, "conviction": 0.5}}',
        THEMES)
    assert out["a"]["direction"] is None


def test_parse_decide_response_rejects_out_of_range_conviction():
    out = flashtext.parse_decide_response(
        '{"a": {"gold": true, "tier": 3, "direction": 1, "conviction": 4.2}}',
        THEMES)
    assert out["a"]["conviction"] is None


def test_parse_decide_response_unknown_theme_falls_back_to_other():
    out = flashtext.parse_decide_response(
        '{"a": {"gold": true, "tier": 3, "direction": 1,'
        ' "conviction": 0.5, "theme": "crypto_vibes"}}', THEMES)
    assert out["a"]["theme"] == "other"


def test_parse_decide_response_absent_theme_falls_back_to_other():
    out = flashtext.parse_decide_response(
        '{"a": {"gold": true, "tier": 3}}', THEMES)
    assert out["a"]["theme"] == "other"
```

- [ ] **Step 2: Update the existing call sites in the test file**

The 6 existing `parse_decide_response(...)` calls and the `build_decide_prompt(...)` calls in `tests/test_flashtext.py` need the new argument. Add `THEMES` as the final positional argument to each:

```bash
uv run pytest tests/test_flashtext.py -v 2>&1 | grep -c TypeError
```

Fix each reported call by appending `, THEMES`. For example line 46 becomes:

```python
    assert flashtext.parse_decide_response(text, THEMES) == {
```

and line 60 becomes:

```python
        flashtext.parse_decide_response("I could not comply.", THEMES)
```

Existing assertions comparing whole verdict dicts (e.g. `test_parse_decide_response_normalizes`) will also need the three new keys added to their expected dicts — `"direction": None, "conviction": None, "theme": "other"` where the fixture JSON omits them.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_flashtext.py -v`
Expected: FAIL — `TypeError: build_decide_prompt() takes 2 positional arguments but 3 were given`, and the new assertions failing on missing keys.

- [ ] **Step 4: Extend the prompt**

In `jamasp/flashtext.py`, change `DECIDE_HEADER` from a plain string to a template. Change its opening line from `For every NEW id decide two things:` to `For every NEW id decide the following:` (it already asks for three; the count was stale). Then insert after the `"tier"` block, before the final `Respond with ONLY` paragraph:

```
4. "direction": which way this pushes the GOLD PRICE, -2 to +2.
   +2 strongly higher, +1 higher, 0 no clear push or genuinely two-sided,
   -1 lower, -2 strongly lower.
   Score gold, not sentiment. A strong dollar print is -2 even though it is
   good news for the dollar. An equity selloff is +1, because haven demand
   supports gold — not 0 because the news itself reads as bad. Ask only:
   does this make gold more expensive or less expensive?
5. "conviction": how sure you are of that direction, 0.0 to 1.0.
   Use a low value when an item plainly matters but its direction is
   genuinely unresolved. A major story you cannot call is a high tier with
   low conviction, which is a useful answer, not a failure.
6. "theme": exactly one of {themes}.
   Pick the transmission channel, not the subject matter: a Middle East
   story that matters because of shipping lanes is geopolitics, and one
   that matters because a central bank is buying is physical_cb. Use
   "other" only when none of the rest fit.
```

and replace the final paragraph with:

```
Respond with ONLY a JSON object mapping each NEW id to
{{"gold": bool, "dup_of": id or null, "tier": 1-5, "direction": -2 to 2,
"conviction": 0.0 to 1.0, "theme": string}}. No other text.
```

Note the doubled braces — `DECIDE_HEADER` is now a `.format()` template, so the literal JSON braces must be escaped. The `{themes}` placeholder is the only real field.

- [ ] **Step 5: Thread `themes` through `build_decide_prompt`**

Replace the signature and return line of `build_decide_prompt` (`jamasp/flashtext.py:143-155`). The body between them is unchanged:

```python
def build_decide_prompt(
    posted: Sequence[Mapping], candidates: Sequence[Mapping],
    themes: Sequence[str]
) -> str:
    header = DECIDE_HEADER.format(themes=", ".join(themes))
    posted_block = (
        "\n".join(f"{p['id']}\t{_one_line(p['title_en'])}" for p in posted)
        or "(none)"
    )
    new_block = "\n".join(
        f"{c['id']}\t{_one_line(c['source'])}\t{_one_line(c['headline'])}"
        f"\t{_one_line(c['lede'])}"
        for c in candidates
    )
    return f"{header}POSTED:\n{posted_block}\n\nNEW:\n{new_block}\n"
```

`Sequence` and `Mapping` are already imported in this file — no import change needed.

- [ ] **Step 6: Add the value parsers**

In `jamasp/flashtext.py`, immediately after `_tier` (line 168):

```python
def _direction(raw: object) -> int | None:
    """A -2..+2 gold-relative direction, or None when unusable.

    None rather than 0: 0 is a real verdict meaning "no clear push", and
    defaulting a missing field to it would fabricate a neutral claim the
    model never made. Same reasoning as _tier.
    """
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if -2 <= value <= 2 else None


def _conviction(raw: object) -> float | None:
    """A 0.0-1.0 confidence in the direction, or None when unusable."""
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if 0.0 <= value <= 1.0 else None


def _theme(raw: object, themes: Sequence[str]) -> str:
    """A configured theme slot, falling back to "other".

    Unlike the scores above this has no None: every scored item occupies a
    box on the map, and an unplaceable one belongs in "other" rather than
    vanishing. config/weights.yaml guarantees the slot exists.
    """
    return raw if isinstance(raw, str) and raw in themes else "other"
```

- [ ] **Step 7: Extend `parse_decide_response`**

Replace the body of `parse_decide_response` (line 171):

```python
def parse_decide_response(text: str, themes: Sequence[str]) -> dict[str, dict]:
    verdicts = {}
    for item_id, raw in _json_object(text).items():
        if not isinstance(raw, dict):
            continue
        dup = raw.get("dup_of")
        verdicts[str(item_id)] = {
            "gold": bool(raw.get("gold")),
            "dup_of": str(dup) if dup else None,
            "tier": _tier(raw.get("tier")),
            "direction": _direction(raw.get("direction")),
            "conviction": _conviction(raw.get("conviction")),
            "theme": _theme(raw.get("theme"), themes),
        }
    return verdicts
```

- [ ] **Step 8: Update the production call site**

In `jamasp/flash.py`, the decide call at line 373. Load the taxonomy and pass it to both functions:

```python
    themes = config_mod.themes(config_mod.load_weights())
    try:
        verdicts = flashtext.parse_decide_response(
            run_model(cfg["decide_cmd"], flashtext.build_decide_prompt(
                list(known.values()), pending, themes
            )),
            themes,
        )
```

`config_mod` is already imported in `jamasp/flash.py`.

- [ ] **Step 9: Run the full suite**

Run: `uv run pytest`
Expected: PASS. `tests/test_flash.py` is large and exercises the decide path; if it fails on the new signature, add the `themes` argument at those call sites too.

- [ ] **Step 10: Commit**

```bash
git add jamasp/flashtext.py jamasp/flash.py tests/test_flashtext.py tests/test_flash.py
git commit -m "feat(flash): triage scores gold-relative direction, conviction and theme"
```

---

### Task 5: Persist every verdict to `item_scores`

**Files:**
- Modify: `jamasp/flash.py` (add `record_scores`; call it after the verdict parse at line 377)
- Test: `tests/test_flash.py`

**Interfaces:**
- Consumes: `item_scores` (Task 2), verdict dicts with `direction`/`conviction`/`theme` (Task 4)
- Produces: `flash.record_scores(conn, verdicts: dict[str, dict]) -> int`, returning the number of rows written. Plan 3 reads the table.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_flash.py`:

```python
def _verdict(gold=True, tier=4, direction=1, conviction=0.6,
             theme="rates_dollar"):
    return {"gold": gold, "dup_of": None, "tier": tier,
            "direction": direction, "conviction": conviction, "theme": theme}


def test_record_scores_writes_one_row_per_gold_item(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    written = flash.record_scores(conn, {"a": _verdict(), "b": _verdict(tier=2)})
    assert written == 2
    rows = conn.execute(
        "SELECT item_id, tier, direction, conviction, theme"
        " FROM item_scores ORDER BY item_id").fetchall()
    assert [r["item_id"] for r in rows] == ["a", "b"]
    assert rows[0]["conviction"] == 0.6


def test_record_scores_covers_items_the_channel_drops(tmp_path):
    # The whole point of a separate table: a tier-2 item never reaches the
    # channel, but it is still news the fundamental map must show. If this
    # ever regresses, the map silently shows only what was published.
    conn = db.connect(tmp_path / "t.db")
    flash.record_scores(conn, {"low": _verdict(tier=1)})
    assert conn.execute(
        "SELECT COUNT(*) FROM item_scores").fetchone()[0] == 1


def test_record_scores_skips_non_gold_items(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    written = flash.record_scores(conn, {"x": _verdict(gold=False)})
    assert written == 0
    assert conn.execute("SELECT COUNT(*) FROM item_scores").fetchone()[0] == 0


def test_record_scores_skips_incomplete_verdicts(tmp_path):
    # A model that dropped a field must not land a row with a fabricated
    # zero — the map would render it as a confident neutral.
    conn = db.connect(tmp_path / "t.db")
    written = flash.record_scores(conn, {
        "no_dir": _verdict(direction=None),
        "no_conv": _verdict(conviction=None),
        "no_tier": _verdict(tier=None),
    })
    assert written == 0


def test_record_scores_replaces_a_prior_score(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    flash.record_scores(conn, {"a": _verdict(tier=3)})
    flash.record_scores(conn, {"a": _verdict(tier=5)})
    rows = conn.execute("SELECT tier FROM item_scores").fetchall()
    assert [r["tier"] for r in rows] == [5]
```

If `db` and `flash` are not already imported at the top of `tests/test_flash.py`, add `from jamasp import db, flash`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_flash.py -k record_scores -v`
Expected: FAIL with `AttributeError: module 'jamasp.flash' has no attribute 'record_scores'`

- [ ] **Step 3: Implement `record_scores`**

In `jamasp/flash.py`, add above `flash_pass` (the function containing line 367):

```python
def record_scores(conn: sqlite3.Connection, verdicts: dict[str, dict]) -> int:
    """Persist the triage verdict for every fully-scored gold item.

    Deliberately independent of delivery. An item held for a rollup, folded
    as a duplicate, or dropped as low tier is still news the market map has
    to show, so this runs over the whole verdict batch before the delivery
    loop makes any of those decisions.

    Non-gold items are skipped: a gold desk's map has no box for them.
    Partly-scored items are skipped too — writing a missing direction as 0
    would render a fabricated confident-neutral tile.
    """
    rows = [
        (item_id, v["tier"], v["direction"], v["conviction"], v["theme"],
         utcnow())
        for item_id, v in verdicts.items()
        if v["gold"]
        and v["tier"] is not None
        and v["direction"] is not None
        and v["conviction"] is not None
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO item_scores"
        " (item_id, tier, direction, conviction, theme, scored_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    return len(rows)
```

`sqlite3` and `utcnow` are already imported in `jamasp/flash.py`.

- [ ] **Step 4: Call it from the flash pass**

In `jamasp/flash.py`, immediately after the `try/except` block that assigns `verdicts` (ending at line 381, before `display = config_mod.display_names(sources)`):

```python
    if not dry_run:
        stats["scored"] = record_scores(conn, verdicts)
```

Add `"scored": 0` to the `stats` dict initialiser (the one at line 330 containing `"born_old": 0, "held": 0, ...`).

- [ ] **Step 5: Run the full suite**

Run: `uv run pytest`
Expected: PASS

- [ ] **Step 6: Report the count in the CLI summary**

In `jamasp/cli.py:165`, the flash summary line already prints `low_tier` and `no_tier`. Add the scored count so the accumulation is observable rather than assumed:

```python
        f"{stats.get('scored', 0)} scored, "
```

- [ ] **Step 7: Verify against a real pass**

Run: `uv run jamasp flash --dry-run`
Expected: the summary line renders without error. Note that `--dry-run` writes nothing, so `scored` reads 0 — that is correct behaviour, not a bug.

- [ ] **Step 8: Commit**

```bash
git add jamasp/flash.py jamasp/cli.py tests/test_flash.py
git commit -m "feat(flash): persist triage scores for every gold item, not just posted ones"
```

---

### Task 6: Widen the TradingView field set to three timeframes

**Files:**
- Modify: `jamasp/ingest/prices.py:107-114` (`TV_FIELD_SUFFIXES`)
- Modify: `config/sources.yaml:282-288` (the `tv_gc_technicals` entry)
- Test: `tests/test_prices.py`

**Interfaces:**
- Consumes: nothing
- Produces: ~51 price series in the existing `prices` table — `GC_RSI14`, `GC_RSI14_1W`, `GC_RSI14_4H`, `GC_MACD`, `GC_FIB_S1`, … Plan 2's fit and Plan 3's technical map read them. **No schema change.**

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_prices.py`:

```python
def test_tv_field_suffixes_cover_three_timeframes():
    m = prices.TV_FIELD_SUFFIXES
    assert m["RSI"] == "RSI14"
    assert m["RSI|1W"] == "RSI14_1W"
    assert m["RSI|240"] == "RSI14_4H"
    assert m["MACD.macd"] == "MACD"
    assert m["Pivot.M.Fibonacci.S1"] == "FIB_S1"


def test_tv_field_suffixes_keep_the_existing_series_names():
    # These four series already hold months of history in the live database.
    # Renaming any of them would orphan it and silently restart the series.
    m = prices.TV_FIELD_SUFFIXES
    assert m["SMA50"] == "SMA50"
    assert m["SMA200"] == "SMA200"
    assert m["ATR"] == "ATR14"
    assert m["Pivot.M.Classic.S1"] == "PIV_S1"
    assert m["Pivot.M.Classic.R1"] == "PIV_R1"


def test_tv_field_suffixes_exclude_the_aggregate_gauges():
    # config/sources.yaml:279 — technicals annotate the macro read, they must
    # not originate calls. Neither market map produces an aggregate verdict.
    keys = set(prices.TV_FIELD_SUFFIXES)
    assert not any(k.startswith("Recommend") for k in keys)


def test_parse_tradingview_scanner_json_reads_multi_timeframe_fields():
    payload = ('{"RSI": 41.2, "RSI|1W": 55.0, "RSI|240": 38.5,'
               ' "MACD.macd": 1.5, "close": 4312.4}')
    out = dict(prices.parse_tradingview_scanner_json(payload))
    assert out["RSI14"] == 41.2
    assert out["RSI14_1W"] == 55.0
    assert out["RSI14_4H"] == 38.5
    assert out["MACD"] == 1.5
    assert out["CLOSE"] == 4312.4


def test_parse_tradingview_scanner_json_skips_nulls():
    # Fields come back null when a timeframe's bar has not closed; storing
    # them as 0.0 would print a fake oversold RSI.
    out = dict(prices.parse_tradingview_scanner_json(
        '{"RSI": 41.2, "RSI|240": null}'))
    assert out == {"RSI14": 41.2}


def test_configured_tv_url_requests_every_mapped_field():
    # The field list lives in the URL and the name mapping lives in code;
    # nothing else stops them drifting apart, and a field absent from the URL
    # is a series that silently never appears.
    from urllib.parse import unquote

    from jamasp import config

    src = next(s for s in config.load_sources()
               if s.name == "tv_gc_technicals")
    url = unquote(src.url)
    for field in prices.TV_FIELD_SUFFIXES:
        assert field in url, f"{field} is mapped but not requested"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_prices.py -k tv -v`
Expected: FAIL — `KeyError: 'RSI|1W'`

- [ ] **Step 3: Rewrite `TV_FIELD_SUFFIXES` as a generated map**

Replace `jamasp/ingest/prices.py:107-114` with:

```python
# The base field set, at TradingView's default (daily) resolution. The
# aggregate buy/sell gauges (Recommend.All / Recommend.MA / Recommend.Other)
# are deliberately absent: technicals annotate the macro read, they must not
# originate calls — see config/sources.yaml.
#
# The five original names (SMA50, SMA200, ATR14, PIV_S1, PIV_R1) and RSI14 are
# preserved exactly. They hold months of history in the live database, and a
# rename would orphan the old series and silently restart it.
_TV_BASE = {
    "close": "CLOSE",
    "RSI": "RSI14",
    "Stoch.K": "STOCH_K",
    "Stoch.D": "STOCH_D",
    "W.R": "WILLR",
    "MACD.macd": "MACD",
    "MACD.signal": "MACD_SIG",
    "ADX": "ADX",
    "SMA50": "SMA50",
    "SMA200": "SMA200",
    "BB.upper": "BB_UPPER",
    "BB.lower": "BB_LOWER",
    "ATR": "ATR14",
    "Pivot.M.Fibonacci.S1": "FIB_S1",
    "Pivot.M.Fibonacci.R1": "FIB_R1",
    "Pivot.M.Classic.S1": "PIV_S1",
    "Pivot.M.Classic.R1": "PIV_R1",
}

# TradingView selects a resolution with a "|<interval>" field suffix; no
# suffix means daily. The empty key must stay first so the daily series keep
# their original unsuffixed names.
_TV_TIMEFRAMES = {"": "", "|1W": "_1W", "|240": "_4H"}

TV_FIELD_SUFFIXES = {
    f"{field}{tf}": f"{name}{tf_name}"
    for field, name in _TV_BASE.items()
    for tf, tf_name in _TV_TIMEFRAMES.items()
}
```

`parse_tradingview_scanner_json` needs no change — it already iterates the map and skips nulls.

- [ ] **Step 4: Update the source URL**

In `config/sources.yaml`, replace the `url:` line of the `tv_gc_technicals` entry (line 284). The `|` characters must be percent-encoded as `%7C`:

```yaml
    url: "https://scanner.tradingview.com/symbol?symbol=COMEX%3AGC1!&fields=close,RSI,Stoch.K,Stoch.D,W.R,MACD.macd,MACD.signal,ADX,SMA50,SMA200,BB.upper,BB.lower,ATR,Pivot.M.Fibonacci.S1,Pivot.M.Fibonacci.R1,Pivot.M.Classic.S1,Pivot.M.Classic.R1,close%7C1W,RSI%7C1W,Stoch.K%7C1W,Stoch.D%7C1W,W.R%7C1W,MACD.macd%7C1W,MACD.signal%7C1W,ADX%7C1W,SMA50%7C1W,SMA200%7C1W,BB.upper%7C1W,BB.lower%7C1W,ATR%7C1W,Pivot.M.Fibonacci.S1%7C1W,Pivot.M.Fibonacci.R1%7C1W,Pivot.M.Classic.S1%7C1W,Pivot.M.Classic.R1%7C1W,close%7C240,RSI%7C240,Stoch.K%7C240,Stoch.D%7C240,W.R%7C240,MACD.macd%7C240,MACD.signal%7C240,ADX%7C240,SMA50%7C240,SMA200%7C240,BB.upper%7C240,BB.lower%7C240,ATR%7C240,Pivot.M.Fibonacci.S1%7C240,Pivot.M.Fibonacci.R1%7C240,Pivot.M.Classic.S1%7C240,Pivot.M.Classic.R1%7C240&no_404=true"
```

Also update the comment above the entry (lines 275-281) to say the set now spans daily, weekly and 4h, and to keep the existing sentence about `Recommend.All` being excluded.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_prices.py -v`
Expected: PASS, including `test_configured_tv_url_requests_every_mapped_field`.

- [ ] **Step 6: Verify against the live endpoint**

Run: `uv run jamasp ingest`

Then confirm the new series are landing:

```bash
sqlite3 state/jamasp.db \
  "SELECT symbol, COUNT(*) FROM prices WHERE symbol LIKE 'GC_%' GROUP BY symbol ORDER BY symbol;"
```

Expected: rows for `GC_RSI14`, `GC_RSI14_1W`, `GC_RSI14_4H`, `GC_MACD`, `GC_FIB_S1` and the rest. **Any field TradingView does not serve simply will not appear** — `parse_tradingview_scanner_json` skips absent and null fields. If a whole timeframe is missing, check whether the scanner accepts that interval suffix for `COMEX:GC1!` before assuming a bug, and record what it actually serves in the source comment.

- [ ] **Step 7: Commit**

```bash
git add jamasp/ingest/prices.py config/sources.yaml tests/test_prices.py
git commit -m "feat(prices): widen TradingView set to 17 fields across daily, weekly and 4h"
```

---

## Done when

- `uv run pytest` passes.
- `uv run jamasp flash` reports a non-zero `scored` count on a tick with gold items.
- `SELECT COUNT(*) FROM item_scores` grows between ingest ticks.
- `SELECT COUNT(DISTINCT symbol) FROM prices WHERE symbol LIKE 'GC_%'` is substantially larger than 6.
- The measured Yahoo intraday depth is recorded in the spec, so Plan 2 can be written.

## Deliberately not in this plan

- `jamasp/indicators.py` (computing signals from OHLC bars), `jamasp/signals.py`
  (classifying a raw value into a -1..+1 state), backfill, and the ridge fit —
  **Plan 2**, which is written once Task 1's measurement is known.
- `lib/marketmap.ts`, `market-map.tsx`, page wiring — **Plan 3**.
- `tier_weight`, horizon, ridge alpha and pins in `config/weights.yaml` — Plan 2 adds them. This plan puts only `themes` in the file, because that is all it needs.
