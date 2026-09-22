"""Pure text for the translate job: prompts, schemas, response parsing.

Nothing here touches the database, the network, or a subprocess, so every
function is directly testable — the same split as jamasp/flashtext.py.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
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

    Shaped for OpenAI STRICT structured output, which is narrower than JSON
    Schema and rejects the obvious encoding. Strict mode requires every object
    to carry `additionalProperties: false` and to list every one of its
    properties in `required`. So:

    - The batch cannot be an object keyed by entry number. That needs
      `additionalProperties` as a *sub-schema* to allow arbitrary keys, which
      strict mode reads as the forbidden open map and rejects with HTTP 400
      `invalid_json_schema`. The entries are an array instead, each carrying
      its own `n`.
    - No field can be optional. A lede often does not exist, and demanding a
      string would make the model invent one, so `lede` is nullable
      (`["string", "null"]`) and required — the model says "absent" by
      returning null rather than by omitting the key.

    This shape is verified against real codex, not only against the fake: see
    `tests/fake_codex.py`, which now enforces the same strict rules so a
    regression here fails in the suite instead of in production.
    """
    return {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "n": {"type": "integer"},
                        **{f: {"type": ["string", "null"]} for f in fields},
                    },
                    "required": ["n", *fields],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["items"],
        "additionalProperties": False,
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

    entries = payload.get("items")
    if not isinstance(entries, list):
        raise ParseError("response has no `items` array")

    out: dict[int, dict[str, str]] = {}
    for value in entries:
        if not isinstance(value, dict):
            continue
        try:
            index = int(value.get("n")) - 1
        except (TypeError, ValueError):
            continue
        if not (0 <= index < count):
            continue
        # A null or blank field means "the model had nothing for this" — for a
        # lede that is the honest answer and the column stays NULL. Dropping
        # the key here is what keeps `lede_fa` absent rather than empty.
        entry = {
            f: str(value[f]).strip()
            for f in fields
            if isinstance(value.get(f), str) and str(value[f]).strip()
        }
        if fields[0] not in entry:
            continue
        out[index] = entry
    return out


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
    sections: list[tuple[str, str, str]], translated_at: str, translator: str,
    source_hash: str,
) -> str:
    """Sidecar text from [(english_heading, section_hash, persian_body)].

    The English heading is an anchor, never rendered: the panel takes headings
    from its own dictionary because StanceKey is a closed enum. Keeping it
    verbatim means this file splits with the same logic as the source, so
    section matching cannot drift between the two.

    `source_hash` is the hash of the WHOLE English file and belongs in the
    front matter; the per-section hashes go in the comment lines. Required
    rather than defaulted because the panel compares the front-matter hash
    against `stance.md` and treats a mismatch as no sidecar at all — an empty
    one mismatches every time, which is a Persian stance that never renders.
    That is also why a caller with a section still in its English fallback
    passes the empty hash on purpose: see `translate.translate_stance`.
    """
    out = [render_front_matter(source_hash, translated_at, translator)]
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
    # "they are not included" was true only above translate.doc_chunk_bytes,
    # where `doc_segments` holds headings out of the prompt entirely. A
    # document under the threshold goes in one call with its `## ` lines in
    # it, so the old rule described a document the model was not looking at —
    # and a small report's headings could come back Persian while a large
    # one's were guaranteed English. Asking for them verbatim makes the two
    # paths agree on the output instead of on a claim about the input.
    #
    # A later rewrite made the same mistake in the other direction, restating
    # a claim about the input instead of dropping it: "a large document ...
    # will contain none" is false twice over. `doc_segments` splits only at
    # `## `, so a `# ` (H1) line always reaches the model regardless of
    # document size, and a `## ` inside a fenced code block deliberately
    # stays in the prose too (see `_inside_fence`). The instruction below
    # needs no claim about what the input does or does not contain — it is
    # unconditional on purpose.
    "- Leave heading lines (any line beginning with #) exactly as they are,"
    " unchanged, in their original language: a heading is an anchor, not"
    " prose.\n"
    "- Apply the glossary.\n"
    '- Return a JSON object: {"text": "<the Persian document>"}.'
)


def build_doc_prompt(text: str, glossary: Mapping[str, str]) -> str:
    return f"{DOC_RULES}\n\n{glossary_block(glossary)}\n\n---\n{text}"


def doc_schema() -> dict:
    """Response shape for one document or stance section.

    `additionalProperties: false` is required by OpenAI strict structured
    output, not decoration — without it codex rejects the call with HTTP 400
    `invalid_json_schema` before the model ever runs. See `rows_schema`.
    """
    return {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
        "additionalProperties": False,
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


# An opening or closing code fence: up to three spaces of indent, then three
# or more backticks or tildes. CommonMark's rule, and the only part of it that
# matters here — a closer must use the same character and be at least as long
# as its opener, and must carry no info string.
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def _inside_fence(lines: Sequence[str]) -> list[bool]:
    """Per line, whether it belongs to a fenced code block.

    The delimiter lines themselves count as inside, so a fence is never cut
    from its own opener or closer.

    Without this, a report that quotes markdown — every deep dive that shows
    what a heading looks like — has its `## ` example lines read as document
    headings. The fence then opens in one model call and closes in the next:
    one chunk arrives unterminated, the other carries a stray closer, and both
    come back mangled. A blank line inside a fence is content for the same
    reason, so the paragraph packer must not cut there either.

    An unterminated fence runs to the end of the text, which is what
    CommonMark does with one too.
    """
    inside: list[bool] = []
    marker = ""
    for line in lines:
        match = _FENCE.match(line)
        if marker:
            inside.append(True)
            if (match and match.group(1)[0] == marker[0]
                    and len(match.group(1)) >= len(marker)
                    and not match.group(2).strip()):
                marker = ""
        elif match:
            marker = match.group(1)
            inside.append(True)
        else:
            inside.append(False)
    return inside


def _paragraph_blocks(body: str) -> list[str]:
    """`body` cut at blank lines into blocks that concatenate back to it.

    A block is one paragraph together with the blank lines that follow it, so
    the separators live inside a block rather than between blocks and nothing
    has to be re-invented when the pieces are joined again.

    Blank lines rather than any finer boundary because a paragraph is the
    smallest unit of prose a translator can be handed without changing its
    meaning: cutting mid-sentence would hand the model half a thought and get
    half a translation back.
    """
    blocks: list[str] = []
    cur: list[str] = []
    has_text = pending_blank = False
    lines = body.splitlines(keepends=True)
    for line, fenced in zip(lines, _inside_fence(lines)):
        # A blank line inside a fence is code, not a paragraph break. Treating
        # it as one splits the fence in half; see `_inside_fence`.
        blank = not line.strip() and not fenced
        if not blank and pending_blank and has_text:
            blocks.append("".join(cur))
            cur, has_text = [], False
        cur.append(line)
        has_text = has_text or not blank
        pending_blank = blank
    if cur:
        blocks.append("".join(cur))
    return blocks


def _pack(blocks: Sequence[str], limit: int) -> list[str]:
    """Greedily group `blocks` into chunks of at most `limit` bytes.

    A single block larger than `limit` is emitted alone and OVERSIZED rather
    than cut: see `doc_segments` for why that is the right trade.
    """
    chunks: list[str] = []
    cur = ""
    for block in blocks:
        if cur and len((cur + block).encode("utf-8")) > limit:
            chunks.append(cur)
            cur = block
        else:
            cur += block
    if cur:
        chunks.append(cur)
    return chunks


def doc_segments(markdown: str, limit: int) -> list[tuple[str, str, str]]:
    """Split a document into translatable segments of at most `limit` bytes.

    Returns `[(before, prose, after)]` with the invariant that

        "".join(before + prose + after for ...) == markdown

    byte for byte. `before` and `after` are structure that must survive
    untranslated — the `## ` heading line and the blank lines around a
    paragraph — and `prose` is the only part a model ever sees. Reassembly is
    therefore `"".join(before + translate(prose) + after)`.

    What that guarantees is narrower than it looks, so state it exactly: the
    `## ` heading lines, the preamble boundary and the blank lines BETWEEN
    chunks come back byte-identical and in their original order, because this
    function never hands them to anybody. Everything inside a `prose` span is
    whatever the model returned for it — lists, emphasis, fences and the
    blank lines within a chunk are asked for verbatim by `DOC_RULES` and are
    not enforced by anything here. "Same structure" is a promise about the
    seams, not about the contents.

    Two levels of splitting, in this order:

    1. At `## ` headings — `split_sections`'s rule, plus one correction it
       does not make: a `## ` line inside a ``` or ~~~ fence is an example of
       a heading, not a heading (`_inside_fence`). The panel's TypeScript twin
       of `split_sections` therefore agrees with this function about every
       document that does not quote markdown, and only stance.md is matched
       section-by-section across the two. Headings never reach the model on
       this path — which is the strongest form of the rule `DOC_RULES` states
       for the single-call path, where they do.
    2. Inside a section that is STILL over `limit`, at blank lines, packed
       greedily into paragraph-sized chunks — never at a blank line inside a
       fence, for the reason in `_inside_fence`.

    A single paragraph longer than `limit` — or a single FENCE longer than
    it, kept whole for the same reason — is the one case neither level can
    serve. It is emitted whole and oversized, on purpose: prose has no safe
    split point below a paragraph, and half a sentence would come back as half
    a translation. Such a chunk may well fail the way the whole document used
    to — and that is now bounded, because `DocLedger` abandons a document that
    keeps failing instead of retrying it every tick forever.

    A segment that is wholly empty is dropped, so a document with no preamble
    does not open with a segment of nothing.
    """
    pieces: list[tuple[str, str]] = []
    heading, body = "", []
    lines = markdown.splitlines(keepends=True)
    for line, fenced in zip(lines, _inside_fence(lines)):
        # `## ` inside a fence is an EXAMPLE of a heading, not one. See
        # `_inside_fence`.
        if line.startswith("## ") and not fenced:
            pieces.append((heading, "".join(body)))
            heading, body = line, []
        else:
            body.append(line)
    pieces.append((heading, "".join(body)))

    out: list[tuple[str, str, str]] = []
    for head, text in pieces:
        chunks = ([text] if len(text.encode("utf-8")) <= limit
                  else _pack(_paragraph_blocks(text), limit))
        for chunk in chunks:
            core = chunk.strip()
            if core:
                lead = chunk[:len(chunk) - len(chunk.lstrip())]
                tail = chunk[len(chunk.rstrip()):]
            else:
                # All whitespace: it is ALL structure. Splitting it into a
                # lead and a tail would duplicate it on reassembly.
                lead, tail = chunk, ""
            if head or core or lead or tail:
                out.append((head + lead, core, tail))
            head = ""
    return out
