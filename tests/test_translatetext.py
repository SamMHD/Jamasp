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


def test_schema_is_strict_mode_compliant():
    """The shape OpenAI strict structured output actually accepts.

    The first production run failed every call with `invalid_json_schema`
    because the schema keyed entries by number, which needs an open
    `additionalProperties` map. Entries are an array now, each carrying `n`.
    """
    schema = tt.rows_schema(("headline", "lede"))
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["items"]
    entry = schema["properties"]["items"]["items"]
    assert entry["additionalProperties"] is False
    assert set(entry["properties"]) == {"n", "headline", "lede"}
    # Strict mode permits no optional property: absence is expressed by a
    # null value, not by omitting the key, so every one is required.
    assert entry["required"] == ["n", "headline", "lede"]
    assert entry["properties"]["lede"]["type"] == ["string", "null"]


def test_parse_maps_entry_numbers_back_to_zero_based_positions():
    out = tt.parse_rows_response(
        {"items": [{"n": 1, "headline": "طلا بالا رفت"},
                   {"n": 2, "headline": "فدرال رزرو"}]},
        count=2, fields=("headline",),
    )
    assert out == {0: {"headline": "طلا بالا رفت"}, 1: {"headline": "فدرال رزرو"}}


def test_parse_accepts_a_json_string_as_well_as_an_object():
    out = tt.parse_rows_response(
        '{"items": [{"n": 1, "headline": "ط"}]}', 1, ("headline",))
    assert out[0]["headline"] == "ط"


def test_parse_drops_out_of_range_and_unnumbered_entries():
    out = tt.parse_rows_response(
        {"items": [{"n": 1, "headline": "ok"},
                   {"n": 9, "headline": "x"},
                   {"n": "nope", "headline": "y"},
                   {"headline": "no n at all"}]},
        count=1, fields=("headline",),
    )
    assert out == {0: {"headline": "ok"}}


def test_parse_skips_entries_missing_the_required_field():
    out = tt.parse_rows_response(
        {"items": [{"n": 1, "lede": "only a lede"},
                   {"n": 2, "headline": "fine"}]},
        count=2, fields=("headline", "lede"),
    )
    assert out == {1: {"headline": "fine"}}


def test_parse_treats_a_null_lede_as_absent():
    """Strict mode cannot omit the key, so the model says `null` instead.

    That must land as no `lede` at all, leaving `lede_fa` NULL — not as the
    string "None" or an empty string, either of which the panel would render.
    """
    out = tt.parse_rows_response(
        {"items": [{"n": 1, "headline": "h", "lede": None}]},
        1, ("headline", "lede"),
    )
    assert out[0] == {"headline": "h"}


def test_parse_rejects_a_payload_without_an_items_array():
    with pytest.raises(tt.ParseError, match="items"):
        tt.parse_rows_response({"1": {"headline": "old shape"}}, 1, ("headline",))


def test_parse_rejects_non_json():
    with pytest.raises(tt.ParseError):
        tt.parse_rows_response("not json at all", 1, ("headline",))


def test_parse_rejects_a_json_array():
    with pytest.raises(tt.ParseError):
        tt.parse_rows_response("[1, 2, 3]", 1, ("headline",))


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


def test_write_atomic_cleans_up_on_replace_failure(tmp_path):
    from unittest.mock import patch

    target = tmp_path / "test.md"
    target.write_text("original\n", encoding="utf-8")

    with patch("os.replace", side_effect=OSError("mock failure")):
        with pytest.raises(OSError, match="mock failure"):
            tt.write_atomic(target, "new content\n")

    # Original file unchanged
    assert target.read_text(encoding="utf-8") == "original\n"
    # No temp files left behind
    assert list(tmp_path.glob("*.tmp*")) == []


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
    text = tt.render_stance_sidecar(
        sections, "2026-09-13T06:14:00Z", "codex", "whole")
    assert tt.parse_stance_sidecar(text) == sections


def test_stance_sidecar_round_trips_a_preamble_section():
    """render_stance_sidecar writes no heading line for an empty heading;
    parse_stance_sidecar must still recover that section rather than
    silently dropping the document's opening lines."""
    sections = [("", "phash", "به عنوان امروز.\n"),
                ("## View", "aaa", "طلا خریدار دارد.\n")]
    text = tt.render_stance_sidecar(
        sections, "2026-09-13T06:14:00Z", "codex", "whole")
    assert tt.parse_stance_sidecar(text) == sections


def test_stance_sidecar_keeps_english_headings_verbatim():
    text = tt.render_stance_sidecar(
        [("## What flips me", "h", "بدنه\n")], "t", "codex", "whole")
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


def test_stance_sidecar_front_matter_carries_the_whole_source_hash():
    """Top-level src_hash is the hash of the WHOLE English source; the
    per-section comments carry the per-section hashes. The panel compares the
    top-level one against stance.md and falls back to English on a mismatch,
    so an empty one is a Persian stance that never renders."""
    text = tt.render_stance_sidecar(
        [("## View", "aaa", "بدنه\n")], "t", "codex", "wholefilehash")
    meta, _ = tt.parse_front_matter(text)
    assert meta["src_hash"] == "wholefilehash"
    assert "<!-- src_hash: aaa -->" in text


BRIEF = """# Jamasp Brief — 2026-09-16

Gold at 3,681.

## Market snapshot

GC=F 3,681.40, DXY 97.2.

Real yields 1.81%.

## What happened

The Fed cut 25bp.

## Outlook

Constructive.
"""


def test_doc_segments_reassemble_to_the_source_byte_for_byte():
    """The invariant the whole chunked path rests on: a reassembled document
    differs from its source only in the prose, never in its structure."""
    segments = tt.doc_segments(BRIEF, 10_000)
    assert "".join(b + p + a for b, p, a in segments) == BRIEF


def test_doc_segments_keeps_every_heading_out_of_the_translated_prose():
    """Headings are structure, and DOC_RULES already tells the model not to
    translate them. Splitting a document is how they stop being sent at all."""
    segments = tt.doc_segments(BRIEF, 40)
    for _, prose, _ in segments:
        assert "## " not in prose


def test_doc_segments_keeps_the_preamble_before_the_first_heading():
    segments = tt.doc_segments(BRIEF, 10_000)
    assert "Gold at 3,681." in segments[0][1]
    assert "Market snapshot" not in segments[0][1]


def test_doc_segments_splits_a_section_that_is_itself_too_large():
    """A single `## ` section over the threshold is the case heading-splitting
    alone cannot serve; it is packed into paragraph-sized chunks instead."""
    body = "\n\n".join(f"Paragraph {i} about gold." for i in range(40))
    text = f"## Deep dive\n\n{body}\n"
    segments = tt.doc_segments(text, 200)
    assert len([p for _, p, _ in segments if p]) > 1
    assert "".join(b + p + a for b, p, a in segments) == text
    for _, prose, _ in segments:
        assert len(prose.encode("utf-8")) <= 200


def test_doc_segments_emits_an_unsplittable_paragraph_whole():
    """A single paragraph larger than the threshold has no safe split point —
    prose is not chunkable below a paragraph without mangling it. It goes as
    one oversized chunk rather than being cut mid-sentence."""
    text = "x" * 500 + "\n"
    segments = tt.doc_segments(text, 100)
    assert len([p for _, p, _ in segments if p]) == 1
    assert "".join(b + p + a for b, p, a in segments) == text


def test_doc_segments_never_sends_whitespace_only_prose():
    text = "## Empty\n\n## Also empty\n\n"
    assert [p for _, p, _ in tt.doc_segments(text, 10)] == ["", ""]
    assert "".join(b + p + a for b, p, a in tt.doc_segments(text, 10)) == text
