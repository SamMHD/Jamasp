import sys

import pytest

from jamasp import modelrun

FAKE = [sys.executable, "tests/fake_codex.py"]
SCHEMA = {"type": "object"}
PROMPT = "[1]\nheadline: Gold climbs"


def run(protocol="codex", timeout=30, cmd=None):
    return modelrun.run_json(cmd or FAKE, protocol, PROMPT, SCHEMA, timeout)


def test_codex_protocol_reads_the_output_file_not_stdout(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "ok")
    assert run() == {"1": {"headline": "FA:1", "lede": "FA-LEDE:1"}}


def test_stdout_protocol_parses_the_last_json_object_on_stdout(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "stdout")
    assert run(protocol="stdout") == {"1": {"headline": "FA:1",
                                            "lede": "FA-LEDE:1"}}


def test_non_zero_exit_raises_model_error(monkeypatch):
    monkeypatch.setenv("FAKE_CODEX_MODE", "fail")
    with pytest.raises(modelrun.ModelError, match="exit 1"):
        run()


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


def test_unknown_protocol_raises():
    with pytest.raises(ValueError, match="protocol"):
        run(protocol="carrier-pigeon")


def test_temp_files_are_cleaned_up(monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_CODEX_MODE", "ok")
    monkeypatch.setenv("TMPDIR", str(tmp_path))
    run()
    assert list(tmp_path.glob("jamasp-translate-*")) == []
