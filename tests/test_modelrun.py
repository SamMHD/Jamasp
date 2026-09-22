import sys

import pytest

from jamasp import modelrun

FAKE = [sys.executable, "tests/fake_codex.py"]
# Strict-mode compliant, because tests/fake_codex.py validates what it is
# handed exactly as the real service does. A bare {"type": "object"} is
# rejected there, which is the point — see that file's module docstring.
SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {"type": "string"}}},
    "required": ["items"],
    "additionalProperties": False,
}
EXPECTED = {"items": [{"n": 1, "headline": "FA:1", "lede": "FA-LEDE:1"}]}
PROMPT = "[1]\nheadline: Gold climbs"


def run(protocol="codex", timeout=30, cmd=None):
    return modelrun.run_json(cmd or FAKE, protocol, PROMPT, SCHEMA, timeout)


def test_codex_protocol_reads_the_output_file_not_stdout(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "ok")
    assert run() == EXPECTED


def test_stdout_protocol_parses_the_last_json_object_on_stdout(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "stdout")
    assert run(protocol="stdout") == EXPECTED


def test_a_schema_that_strict_mode_would_reject_is_caught(monkeypatch):
    """The regression guard for the first production run's total failure.

    Every model call 400ed with `invalid_json_schema` because the shipped
    schema used `additionalProperties` as a sub-schema. The suite was green,
    because the fake ignored the schema. It does not any more.
    """
    monkeypatch.setenv("FAKE_CODEX_MODE", "ok")
    open_map = {
        "type": "object",
        "additionalProperties": {"type": "object", "properties": {},
                                 "required": []},
    }
    with pytest.raises(modelrun.ModelError, match="additionalProperties"):
        modelrun.run_json(FAKE, "codex", PROMPT, open_map, 30)


def test_a_schema_omitting_a_property_from_required_is_caught(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "ok")
    loose = {
        "type": "object",
        "properties": {"a": {"type": "string"}, "b": {"type": "string"}},
        "required": ["a"],
        "additionalProperties": False,
    }
    with pytest.raises(modelrun.ModelError, match="required"):
        modelrun.run_json(FAKE, "codex", PROMPT, loose, 30)


def test_non_zero_exit_raises_model_error(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "fail")
    with pytest.raises(modelrun.ModelError, match="exit 1"):
        run()


def test_a_quota_message_raises_quota_exhausted_not_plain_model_error(monkeypatch):
    """The regression guard for docs/todo/025: a quota outage must be
    distinguishable from an ordinary translator failure so translate.py can
    abort instead of fanning out into 22x the calls."""
    monkeypatch.setenv("FAKE_CODEX_MODE", "quota")
    with pytest.raises(modelrun.QuotaExhausted, match="usage limit"):
        run()


def test_quota_exhausted_is_still_a_model_error(monkeypatch):
    """Existing `except ModelError` sites must keep catching it."""
    monkeypatch.setenv("FAKE_CODEX_MODE", "quota")
    with pytest.raises(modelrun.ModelError):
        run()


def test_an_ordinary_failure_does_not_trip_the_quota_signature(monkeypatch):
    """A false positive here would stop a healthy run over a plain refusal —
    the match must require the billing-specific phrasing, not just any
    failure."""
    monkeypatch.setenv("FAKE_CODEX_MODE", "fail")
    try:
        run()
    except modelrun.QuotaExhausted:
        pytest.fail("an ordinary failure must not raise QuotaExhausted")
    except modelrun.ModelError:
        pass


def test_garbage_output_raises_model_error(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "garbage")
    with pytest.raises(modelrun.ModelError):
        run()


def test_empty_output_raises_model_error(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "empty")
    with pytest.raises(modelrun.ModelError):
        run()


def test_timeout_raises_model_error(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "hang")
    with pytest.raises(modelrun.ModelError, match="timed out"):
        run(timeout=1)


def test_missing_binary_raises_model_error():
    with pytest.raises(modelrun.ModelError):
        run(cmd=["definitely-not-a-real-binary-9f2a"])


@pytest.mark.parametrize("text", [
    "ERROR: You've hit your usage limit. Upgrade to Pro.",
    "usage limit reached; purchase more credits to continue",
    "USAGE LIMIT — please upgrade your plan",
])
def test_is_quota_exhausted_matches_the_billing_signature(text):
    assert modelrun._is_quota_exhausted(text)


@pytest.mark.parametrize("text", [
    "I can't help with that request.",
    "connection reset by peer",
    "usage limit",                       # no credit/upgrade phrasing
    "please upgrade your client to the latest version",  # upgrade, no quota
])
def test_is_quota_exhausted_ignores_unrelated_failures(text):
    assert not modelrun._is_quota_exhausted(text)


def test_unknown_protocol_raises():
    with pytest.raises(ValueError, match="protocol"):
        run(protocol="carrier-pigeon")


def test_temp_files_are_cleaned_up(monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_CODEX_MODE", "ok")
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    run()
    assert list(tmp_path.glob("jamasp-translate-*")) == []
