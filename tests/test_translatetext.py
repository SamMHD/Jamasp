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
