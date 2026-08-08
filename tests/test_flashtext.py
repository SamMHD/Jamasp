import pytest

from jamasp import flashtext


def test_build_decide_prompt_lists_posted_and_new():
    posted = [{"id": "aaa", "title_en": "Gold hits record"}]
    candidates = [
        {"id": "bbb", "source": "cnbc_finance", "headline": "Bullion surges",
         "lede": "Spot gold rose."},
        {"id": "ccc", "source": "wgc", "headline": "ETF inflows", "lede": None},
    ]
    prompt = flashtext.build_decide_prompt(posted, candidates)
    assert "aaa\tGold hits record" in prompt
    assert "bbb\tcnbc_finance\tBullion surges\tSpot gold rose." in prompt
    assert "ccc\twgc\tETF inflows\t" in prompt
    assert "POSTED" in prompt and "NEW" in prompt


def test_build_decide_prompt_handles_empty_posted():
    prompt = flashtext.build_decide_prompt(
        [], [{"id": "bbb", "source": "s", "headline": "h", "lede": None}]
    )
    assert "(none)" in prompt


def test_parse_decide_response_normalizes():
    text = 'ok:\n```json\n{"bbb": {"gold": true, "dup_of": "aaa"},' \
           ' "ccc": {"gold": false, "dup_of": null}}\n```'
    assert flashtext.parse_decide_response(text) == {
        "bbb": {"gold": True, "dup_of": "aaa"},
        "ccc": {"gold": False, "dup_of": None},
    }


def test_parse_decide_response_tolerates_missing_keys():
    assert flashtext.parse_decide_response('{"bbb": {"gold": true}}') == {
        "bbb": {"gold": True, "dup_of": None}
    }


def test_parse_decide_response_raises_without_json():
    with pytest.raises(ValueError, match="no JSON object"):
        flashtext.parse_decide_response("I could not comply.")


def test_build_write_prompt_includes_article_text():
    prompt = flashtext.build_write_prompt(
        "Gold hits record", "Reuters", "2026-08-08T10:32:00Z", "Full article body."
    )
    assert "Full article body." in prompt
    assert "HEADLINE: Gold hits record" in prompt
    assert "SOURCE: Reuters" in prompt


def test_build_write_prompt_falls_back_to_lede():
    prompt = flashtext.build_write_prompt(
        "Gold hits record", "Reuters", "2026-08-08T10:32:00Z", "", lede="Spot rose."
    )
    assert "UNAVAILABLE" in prompt
    assert "Spot rose." in prompt


def test_parse_write_response_returns_three_fields():
    text = '{"title_fa": "t", "summary_fa": "s", "impact_fa": "i"}'
    assert flashtext.parse_write_response(text) == {
        "title_fa": "t", "summary_fa": "s", "impact_fa": "i"
    }


def test_parse_write_response_raises_on_missing_field():
    with pytest.raises(ValueError, match="impact_fa"):
        flashtext.parse_write_response('{"title_fa": "t", "summary_fa": "s"}')


def test_render_message_golden():
    text = flashtext.render_message(
        title_fa="طلا رکورد زد",
        summary_fa="خلاصه فارسی.",
        impact_fa="تحلیل فارسی.",
        url="https://e/1",
        published_at="2026-08-08T10:32:00Z",
        source_labels=["Reuters", "CNBC"],
    )
    assert text == (
        "🟡 طلا رکورد زد\n"
        "\n"
        "خلاصه فارسی.\n"
        "\n"
        "اثر احتمالی: تحلیل فارسی.\n"
        "\n"
        "منابع: Reuters • CNBC\n"
        "https://e/1\n"
        "⏱ 14:32 دبی"
    )


def test_render_message_truncates():
    text = flashtext.render_message(
        "t", "x" * 6000, "i", "https://e/1", "2026-08-08T10:32:00Z", ["Reuters"]
    )
    assert len(text) <= flashtext.MAX_CHARS
    assert text.endswith("…")
