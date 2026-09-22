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


class QuotaExhausted(ModelError):
    """The translator refused because its usage/billing allowance is spent.

    A subclass, not a sibling, of ModelError: a caller that only knows about
    ModelError (there were none left to update) still catches this. But it is
    a distinct type because it is not a property of the call that failed —
    every OTHER call in the run will fail identically until the quota resets
    elsewhere, at a time this process does not control. `translate.py`'s
    batch-then-singles fallback existed to stop one bad headline poisoning
    nineteen good ones; pointed at a quota outage instead, it turned one
    exhausted batch into 21 more calls that were guaranteed to fail the same
    way, deepening the very shortage that caused them. That fan-out is what
    drove 1,861 rows to the attempt cap and abandoned them across three
    separate outages on the live host (docs/todo/025) — so `translate.py`
    catches this type ahead of ModelError and aborts instead of retrying.
    """


# The signature codex prints on stderr when its usage allowance is spent, e.g.
#   ERROR: You've hit your usage limit. Upgrade to Pro
#   (https://chatgpt.com/explore/pro), visit
#   https://chatgpt.com/codex/settings/usage to purchase more credits or
#   try again at 10:00 PM.
# Matched on "usage limit" plus either "credit" or "upgrade" — the pair that
# identifies a BILLING state — rather than the whole sentence, so a reworded
# reset time or URL still trips it. An ordinary content refusal never pairs
# "usage limit" with either word, so this should not fire on one; a refusal
# that manages to say all three, whatever it is refusing, IS a quota message
# for this purpose.
def _is_quota_exhausted(text: str) -> bool:
    lowered = text.lower()
    return "usage limit" in lowered and (
        "credit" in lowered or "upgrade" in lowered
    )


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

    # dir=os.environ.get("TMPDIR") reads the env var at call time rather than
    # relying on tempfile's process-wide cached default, which — once any
    # earlier code in the process has resolved it — ignores later changes to
    # TMPDIR. Tests rely on this to redirect temp files under tmp_path.
    tmpdir = tempfile.mkdtemp(
        prefix="jamasp-translate-", dir=os.environ.get("TMPDIR")
    )
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
            combined = proc.stderr or proc.stdout or ""
            tail = combined.strip()[-300:]
            if _is_quota_exhausted(combined):
                raise QuotaExhausted(
                    f"translator exit {proc.returncode}: {tail}")
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
