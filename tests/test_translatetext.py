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
