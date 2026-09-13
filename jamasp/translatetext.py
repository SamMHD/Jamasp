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
