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
