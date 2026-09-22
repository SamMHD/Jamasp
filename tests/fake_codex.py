"""Stand-in for `codex exec` in translate tests.

Honours the two flags the codex protocol uses — `--output-schema FILE` and
`-o FILE` — and writes its answer to the `-o` path, exactly as codex does.
Stdout carries session noise, so a test proves the parser reads the file and
not the stream.

**This fake validates the schema it is handed.** The first production run of
`jamasp translate` failed every single model call with HTTP 400
`invalid_json_schema`, because OpenAI strict structured output is narrower
than JSON Schema and the shipped schema was legal JSON Schema but illegal
under strict mode. The suite was 651 tests green at the time and could not
have caught it: this fake ignored `--output-schema` entirely and answered
whatever it liked. A fake that accepts what the real service rejects is not a
test double, it is a blindfold — so `_assert_strict` below enforces the rules
that actually bit us, and any schema change that breaks them fails here
instead of in production.

Mode comes from FAKE_CODEX_MODE:
  ok       echo each numbered entry back with an FA: prefix
  garbage  write prose to the output file
  empty    write nothing to the output file
  fail     exit non-zero
  quota    exit non-zero with the real usage-limit message (QuotaExhausted)
  hang     sleep past any sane timeout
  stdout   print the JSON to stdout instead (the `stdout` protocol)
  lax      skip strict-schema validation (for tests about other failures)
  oversize refuse a document payload over FAKE_CODEX_MAX_BYTES (default
           12000) and answer anything smaller normally

`oversize` reproduces the failure that took the translate timer down. On the
live host, at `timeout_seconds: 180`, an 11,362-byte and an 11,455-byte brief
both translated in one call; a 21,728-byte brief timed out, and every report
above roughly 12KB did the same — with the pending queue running 19,767 to
26,968 bytes, not one of them could ever have succeeded. This mode refuses on
exactly that boundary so the chunked path is proved against a translator that
says no to what the real one said no to, without a test sleeping for 180
seconds.
"""
import json
import os
import re
import sys
import time

argv = sys.argv[1:]
prompt = argv[-1]


def _flag(*names):
    for name in names:
        if name in argv:
            return argv[argv.index(name) + 1]
    return None


out_path = _flag("-o", "--output-last-message")
schema_path = _flag("--output-schema")

mode = os.environ.get("FAKE_CODEX_MODE", "ok")


def _assert_strict(node, where="root"):
    """Reject anything OpenAI strict structured output would reject.

    Mirrors the two rules that produced the real 400: every object must set
    `additionalProperties: false`, and must list every property in `required`.
    An `additionalProperties` that is a sub-schema rather than `false` is the
    exact construct that failed — it is how you write "an object with
    arbitrary keys", which strict mode does not allow at all.
    """
    if not isinstance(node, dict):
        return
    if node.get("type") == "object":
        extra = node.get("additionalProperties")
        if extra is not False:
            raise SystemExit(
                f"fake_codex: schema at {where} has additionalProperties="
                f"{extra!r}; strict mode requires exactly False"
            )
        props = node.get("properties") or {}
        required = node.get("required") or []
        missing = sorted(set(props) - set(required))
        if missing:
            raise SystemExit(
                f"fake_codex: schema at {where} omits {missing} from"
                " `required`; strict mode requires every property"
            )
        for name, child in props.items():
            _assert_strict(child, f"{where}.{name}")
    if node.get("type") == "array":
        _assert_strict(node.get("items"), f"{where}[]")


if schema_path and mode != "lax":
    with open(schema_path, encoding="utf-8") as fh:
        _assert_strict(json.load(fh))

if mode == "fail":
    print("codex: boom", file=sys.stderr)
    sys.exit(1)
if mode == "quota":
    # The real message that fanned a quota outage into 22x the calls it
    # should have cost (docs/todo/025) — verbatim modulo the reset time, so
    # modelrun's signature match is exercised against actual production text
    # rather than a paraphrase that would pass even if the match were wrong.
    print(
        "ERROR: You've hit your usage limit. Upgrade to Pro"
        " (https://chatgpt.com/explore/pro), visit"
        " https://chatgpt.com/codex/settings/usage to purchase more credits"
        " or try again at 10:00 PM.",
        file=sys.stderr,
    )
    sys.exit(1)
if mode == "hang":
    time.sleep(30)
    sys.exit(0)
if mode == "oversize":
    # The document payload only — build_doc_prompt puts the source after a
    # `---` fence, and the rules and glossary ahead of it are fixed overhead
    # that no amount of chunking can remove.
    payload = prompt.split("---\n", 1)[-1]
    limit = int(os.environ.get("FAKE_CODEX_MAX_BYTES", "12000"))
    if len(payload.encode("utf-8")) > limit:
        # Non-zero with a timeout-shaped message, which modelrun turns into
        # the same ModelError a real `subprocess` timeout raises. Deliberately
        # says nothing about usage limits or credits, so it cannot be mistaken
        # for a quota outage by modelrun._is_quota_exhausted.
        print(f"codex: request of {len(payload.encode('utf-8'))} bytes"
              f" exceeded the {limit}-byte envelope and timed out",
              file=sys.stderr)
        sys.exit(1)

if "<?document?>" in prompt or '"text"' in prompt:
    body = json.dumps({"text": "FA:" + prompt.split("---\n", 1)[-1]},
                      ensure_ascii=False)
else:
    body = json.dumps(
        {"items": [
            {"n": int(n), "headline": f"FA:{n}", "lede": f"FA-LEDE:{n}"}
            for n in re.findall(r"^\[(\d+)\]$", prompt, flags=re.MULTILINE)
        ]},
        ensure_ascii=False,
    )

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
