import pytest
from pathlib import Path

from study_roulette.studies import (
    Fallback,
    StudiesFileError,
    Study,
    choose_study,
    eligible_studies,
    parse_studies_file,
)

FALLBACK = """
[fallback]
url = "https://example.com/fallback"
"""


def test_parses_valid_file(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 1},
    {url = "https://example.com/study2", weight = 2},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert len(result.studies) == 2
    assert result.errors == []
    assert result.studies[0] == Study(url="https://example.com/study1", weight=1.0)
    assert result.studies[1] == Study(url="https://example.com/study2", weight=2.0)
    assert result.fallback == Fallback(url="https://example.com/fallback")


def test_parses_multiline_format(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
[[studies]]
url = "https://example.com/study1"
weight = 1

[[studies]]
url = "https://example.com/study2"
weight = 2
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert len(result.studies) == 2
    assert result.errors == []


def test_ignores_extra_keys(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 1, name = "Study One", active = true},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert len(result.studies) == 1
    assert result.studies[0].url == "https://example.com/study1"


def test_parses_note(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 1, note = "First study"},
    {url = "https://example.com/study2", weight = 1},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies[0].note == "First study"
    assert result.studies[1].note is None


def test_coerces_note_to_string(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 1, note = 123},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies[0].note == "123"


def test_accepts_zero_weight(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 0},
    {url = "https://example.com/study2", weight = 1},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert len(result.studies) == 2
    assert result.studies[0].weight == 0.0


def test_accepts_decimal_weights(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 0.5},
    {url = "https://example.com/study2", weight = 1.5},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies[0].weight == 0.5
    assert result.studies[1].weight == 1.5


def test_accepts_integer_weights(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 1},
    {url = "https://example.com/study2", weight = 2},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies[0].weight == 1.0
    assert result.studies[1].weight == 2.0


def test_raises_on_missing_file(tmp_path: Path) -> None:
    studies_file = tmp_path / "nonexistent.toml"

    with pytest.raises(StudiesFileError, match="Cannot read studies file"):
        parse_studies_file(studies_file)


def test_accepts_empty_studies_array(tmp_path: Path) -> None:
    """An empty studies array is fine; everything routes to the fallback."""
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("studies = []" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies == []
    assert result.errors == []
    assert result.fallback is not None


def test_raises_on_missing_studies_key(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text('title = "My Studies"' + FALLBACK)

    with pytest.raises(StudiesFileError, match="Missing required key 'studies'"):
        parse_studies_file(studies_file)


def test_raises_on_invalid_toml(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("this is not valid toml [[[")

    with pytest.raises(StudiesFileError, match="Invalid TOML"):
        parse_studies_file(studies_file)


def test_returns_error_on_invalid_url(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "not-a-url", weight = 1},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies == []
    assert any("invalid URL" in e for e in result.errors)


def test_returns_error_on_negative_weight(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = -1},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies == []
    assert any("non-negative" in e for e in result.errors)


def test_returns_error_on_missing_url(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {weight = 1},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies == []
    assert any("missing required key 'url'" in e for e in result.errors)


def test_returns_error_on_missing_weight(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1"},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies == []
    assert any("missing required key 'weight'" in e for e in result.errors)


def test_accepts_all_zero_weights(tmp_path: Path) -> None:
    """All-zero weights are fine now; everything routes to the fallback."""
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 0},
    {url = "https://example.com/study2", weight = 0},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert len(result.studies) == 2
    assert result.errors == []


def test_partial_parse_returns_valid_studies_and_errors(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 1},
    {url = "not-a-url", weight = 1},
    {url = "https://example.com/study2", weight = 2},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert len(result.studies) == 2
    assert result.studies[0].url == "https://example.com/study1"
    assert result.studies[1].url == "https://example.com/study2"
    assert len(result.errors) == 1
    assert "invalid URL" in result.errors[0]


def test_parses_required_and_key_params(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 1, required_params = ["email", "ts", "cn"], key_params = ["email"]},
    {url = "https://example.com/study2", weight = 1, required_params = ["email"]},
    {url = "https://example.com/study3", weight = 1},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.errors == []
    assert result.studies[0].required_params == ["email", "ts", "cn"]
    assert result.studies[0].key_params == ["email"]
    assert result.studies[1].required_params == ["email"]
    assert result.studies[1].key_params is None
    assert result.studies[2].required_params == []
    assert result.studies[2].key_params is None


def test_returns_error_when_key_params_not_subset(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 1, required_params = ["email"], key_params = ["email", "ts"]},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies == []
    assert any("subset of required_params" in e for e in result.errors)


def test_returns_error_on_non_string_param_lists(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 1, required_params = [1, 2]},
    {url = "https://example.com/study2", weight = 1, required_params = "email"},
]
""" + FALLBACK)

    result = parse_studies_file(studies_file)

    assert result.studies == []
    assert len(result.errors) == 2
    assert all("array of strings" in e for e in result.errors)


def test_returns_error_on_missing_fallback(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = [
    {url = "https://example.com/study1", weight = 1},
]
""")

    result = parse_studies_file(studies_file)

    assert len(result.studies) == 1
    assert result.fallback is None
    assert any("fallback" in e for e in result.errors)


def test_parses_fallback_note(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = []

[fallback]
url = "https://example.com/registry"
note = "The registry"
""")

    result = parse_studies_file(studies_file)

    assert result.errors == []
    assert result.fallback == Fallback(
        url="https://example.com/registry", note="The registry"
    )


def test_returns_error_on_invalid_fallback_url(tmp_path: Path) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text("""
studies = []

[fallback]
url = "not-a-url"
""")

    result = parse_studies_file(studies_file)

    assert result.fallback is None
    assert any("invalid URL" in e for e in result.errors)


@pytest.mark.parametrize("key", ["weight = 1", 'required_params = ["email"]', "key_params = []"])
def test_returns_error_on_forbidden_fallback_keys(tmp_path: Path, key: str) -> None:
    studies_file = tmp_path / "studies.toml"
    studies_file.write_text(f"""
studies = []

[fallback]
url = "https://example.com/registry"
{key}
""")

    result = parse_studies_file(studies_file)

    assert result.fallback is None
    assert any("must not have" in e for e in result.errors)


def test_eligible_studies_filters_on_required_params() -> None:
    study_a = Study(
        url="https://example.com/a", weight=1.0, required_params=["email"]
    )
    study_b = Study(
        url="https://example.com/b",
        weight=1.0,
        required_params=["email", "ts", "cn"],
    )
    studies = [study_a, study_b]

    assert eligible_studies(studies, {"email": ["a@b.com"]}) == [study_a]
    assert eligible_studies(
        studies, {"email": ["a@b.com"], "ts": ["1"], "cn": ["2"]}
    ) == [study_a, study_b]
    assert eligible_studies(studies, {"id": ["123"]}) == []


def test_eligible_studies_blank_value_counts_as_present() -> None:
    study = Study(url="https://example.com/a", weight=1.0, required_params=["email"])

    assert eligible_studies([study], {"email": [""]}) == [study]


def test_eligible_studies_no_required_params_always_eligible() -> None:
    study = Study(url="https://example.com/a", weight=1.0)

    assert eligible_studies([study], {"anything": ["at all"]}) == [study]


def test_choose_study_chooses_from_studies() -> None:
    studies = [
        Study(url="https://example.com/study1", weight=1.0),
        Study(url="https://example.com/study2", weight=1.0),
    ]

    chosen = choose_study(studies)

    assert chosen in studies


def test_choose_study_excludes_zero_weight() -> None:
    studies = [
        Study(url="https://example.com/study1", weight=0.0),
        Study(url="https://example.com/study2", weight=1.0),
    ]

    for _ in range(100):
        chosen = choose_study(studies)
        assert chosen.url == "https://example.com/study2"


def test_choose_study_respects_weights() -> None:
    studies = [
        Study(url="https://example.com/study1", weight=1.0),
        Study(url="https://example.com/study2", weight=99.0),
    ]

    counts = {"study1": 0, "study2": 0}
    for _ in range(1000):
        chosen = choose_study(studies)
        if "study1" in chosen.url:
            counts["study1"] += 1
        else:
            counts["study2"] += 1

    # study2 should be chosen roughly 99x more often
    assert counts["study2"] > counts["study1"] * 10


def test_choose_study_raises_on_no_eligible() -> None:
    studies = [
        Study(url="https://example.com/study1", weight=0.0),
    ]

    with pytest.raises(ValueError, match="No eligible studies"):
        choose_study(studies)
