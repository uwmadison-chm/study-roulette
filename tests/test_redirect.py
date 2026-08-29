from collections.abc import Callable
from pathlib import Path

from study_roulette.redirect import (
    candidate_hashes,
    compute_hash,
    get_or_create_redirect,
    merge_urls,
)
from study_roulette.settings import Settings
from study_roulette.studies import Fallback, Study

FALLBACK = Fallback(url="https://example.com/fallback")


def test_compute_hash_is_stable() -> None:
    params = {"email": ["foo@bar.com"], "ts": ["12345"]}

    hash1 = compute_hash(params)
    hash2 = compute_hash(params)

    assert hash1 == hash2


def test_compute_hash_is_order_independent() -> None:
    params1 = {"email": ["foo@bar.com"], "ts": ["12345"]}
    params2 = {"ts": ["12345"], "email": ["foo@bar.com"]}

    assert compute_hash(params1) == compute_hash(params2)


def test_compute_hash_sorts_values() -> None:
    params1 = {"tags": ["a", "b", "c"]}
    params2 = {"tags": ["c", "b", "a"]}

    assert compute_hash(params1) == compute_hash(params2)


def test_compute_hash_differs_for_different_params() -> None:
    params1 = {"email": ["foo@bar.com"]}
    params2 = {"email": ["other@bar.com"]}

    assert compute_hash(params1) != compute_hash(params2)


def test_compute_hash_format_is_frozen() -> None:
    """
    The hash format keys every mapping already stored in production LOOKUP_DIRs.
    If this test fails, existing participants will be re-randomized. Do not
    change the expected value; fix the code.
    """
    params = {"email": ["foo@bar.com"], "ts": ["12345"]}

    assert compute_hash(params) == (
        "57499226b526e9e6429b0a53afbbb566746d9510ca9299022233b2af17d17ea9"
    )


def test_merge_urls_adds_params_to_base() -> None:
    base_url = "https://example.com/survey"
    incoming = {"email": ["foo@bar.com"], "ts": ["12345"]}

    result = merge_urls(base_url, incoming)

    assert "email=foo%40bar.com" in result
    assert "ts=12345" in result


def test_merge_urls_base_params_take_precedence() -> None:
    base_url = "https://example.com/survey?study_id=abc"
    incoming = {"study_id": ["xyz"], "email": ["foo@bar.com"]}

    result = merge_urls(base_url, incoming)

    assert "study_id=abc" in result
    assert "study_id=xyz" not in result
    assert "email=foo%40bar.com" in result


def test_merge_urls_preserves_base_url_structure() -> None:
    base_url = "https://example.com/path/to/survey?s=12345"
    incoming = {"email": ["foo@bar.com"]}

    result = merge_urls(base_url, incoming)

    assert result.startswith("https://example.com/path/to/survey")
    assert "s=12345" in result


def test_candidate_hashes_most_specific_first() -> None:
    params = {"email": ["a@b.com"], "ts": ["1"], "cn": ["2"]}
    studies = [
        Study(
            url="https://example.com/a",
            weight=1.0,
            required_params=["email"],
            key_params=["email"],
        ),
        Study(
            url="https://example.com/b",
            weight=1.0,
            required_params=["email", "ts"],
            key_params=["email", "ts"],
        ),
    ]

    hashes = candidate_hashes(studies, params)

    assert hashes == [
        compute_hash(params),
        compute_hash({"email": ["a@b.com"], "ts": ["1"]}),
        compute_hash({"email": ["a@b.com"]}),
    ]


def test_candidate_hashes_skips_routes_missing_key_params() -> None:
    params = {"email": ["a@b.com"]}
    studies = [
        Study(
            url="https://example.com/a",
            weight=1.0,
            required_params=["email", "cn"],
            key_params=["email", "cn"],
        ),
    ]

    hashes = candidate_hashes(studies, params)

    assert hashes == [compute_hash(params)]


def test_candidate_hashes_dedupes() -> None:
    params = {"email": ["a@b.com"]}
    studies = [
        Study(
            url="https://example.com/a",
            weight=1.0,
            required_params=["email"],
            key_params=["email"],
        ),
        Study(
            url="https://example.com/b",
            weight=1.0,
            required_params=["email"],
            key_params=["email"],
        ),
    ]

    # The studies' key sets and the all-params key are all {email}
    assert candidate_hashes(studies, params) == [compute_hash(params)]


def test_get_or_create_redirect_creates_new(
    make_settings: Callable[..., Settings],
) -> None:
    studies = [Study(url="https://example.com/survey?s=abc", weight=1)]
    settings = make_settings(studies)
    params = {"email": ["foo@bar.com"]}

    result = get_or_create_redirect(settings.lookup_dir, studies, FALLBACK, params)

    assert result.startswith("https://example.com/survey")
    assert "s=abc" in result
    assert "email=foo%40bar.com" in result


def test_get_or_create_redirect_returns_cached(
    make_settings: Callable[..., Settings],
) -> None:
    studies = [
        Study(url="https://example.com/survey1", weight=1),
        Study(url="https://example.com/survey2", weight=1),
    ]

    settings = make_settings(studies)
    params = {"email": ["foo@bar.com"]}

    result1 = get_or_create_redirect(settings.lookup_dir, studies, FALLBACK, params)
    for _ in range(100):
        result2 = get_or_create_redirect(settings.lookup_dir, studies, FALLBACK, params)
        assert result1 == result2


def test_get_or_create_redirect_different_params_different_results(
    make_settings: Callable[..., Settings],
) -> None:
    studies = [Study(url="https://example.com/survey", weight=1)]
    settings = make_settings(studies)

    result1 = get_or_create_redirect(
        settings.lookup_dir, studies, FALLBACK, {"email": ["a@b.com"]}
    )
    result2 = get_or_create_redirect(
        settings.lookup_dir, studies, FALLBACK, {"email": ["x@y.com"]}
    )

    # URLs will be different due to different email params
    assert result1 != result2


def test_uses_fallback_when_no_study_eligible(
    make_settings: Callable[..., Settings],
) -> None:
    studies = [
        Study(url="https://example.com/a", weight=1, required_params=["email"]),
    ]
    settings = make_settings(studies)

    result = get_or_create_redirect(
        settings.lookup_dir, studies, FALLBACK, {"id": ["123"]}
    )

    assert result.startswith(FALLBACK.url)
    assert "id=123" in result


def test_uses_fallback_when_eligible_studies_have_zero_weight(
    make_settings: Callable[..., Settings],
) -> None:
    studies = [
        Study(url="https://example.com/a", weight=0, required_params=["email"]),
    ]
    settings = make_settings(studies)

    result = get_or_create_redirect(
        settings.lookup_dir, studies, FALLBACK, {"email": ["a@b.com"]}
    )

    assert result.startswith(FALLBACK.url)


def test_only_eligible_studies_are_chosen(
    make_settings: Callable[..., Settings],
) -> None:
    studies = [
        Study(url="https://example.com/a", weight=1, required_params=["email"]),
        Study(
            url="https://example.com/b",
            weight=1000,
            required_params=["email", "ts", "cn"],
        ),
    ]
    settings = make_settings(studies)

    for i in range(20):
        result = get_or_create_redirect(
            settings.lookup_dir, studies, FALLBACK, {"email": [f"user{i}@b.com"]}
        )
        assert result.startswith("https://example.com/a")


def test_key_params_make_randomization_stable_across_other_params(
    make_settings: Callable[..., Settings],
) -> None:
    """Two studies keyed on email: the same email always gets the same study,
    no matter what the other parameters do."""
    studies = [
        Study(
            url="https://example.com/a",
            weight=1,
            required_params=["email"],
            key_params=["email"],
        ),
        Study(
            url="https://example.com/b",
            weight=1,
            required_params=["email"],
            key_params=["email"],
        ),
    ]
    settings = make_settings(studies)

    first = get_or_create_redirect(
        settings.lookup_dir,
        studies,
        FALLBACK,
        {"email": ["a@b.com"], "ts": ["111"]},
    )
    for ts in ["222", "333"]:
        later = get_or_create_redirect(
            settings.lookup_dir,
            studies,
            FALLBACK,
            {"email": ["a@b.com"], "ts": [ts]},
        )
        # Same study, and the stored ts wins over the new one
        assert later == first


def test_missing_params_are_replayed_from_stored_mapping(
    make_settings: Callable[..., Settings],
) -> None:
    """A ts-less second visit with the same email goes to the stored
    destination, original ts included."""
    studies = [
        Study(
            url="https://example.com/b",
            weight=1,
            required_params=["email", "ts", "cn"],
            key_params=["email"],
        ),
    ]
    settings = make_settings(studies)

    first = get_or_create_redirect(
        settings.lookup_dir,
        studies,
        FALLBACK,
        {"email": ["a@b.com"], "ts": ["111"], "cn": ["9"]},
    )
    assert first.startswith("https://example.com/b")

    later = get_or_create_redirect(
        settings.lookup_dir, studies, FALLBACK, {"email": ["a@b.com"]}
    )

    assert later == first
    assert "ts=111" in later
    assert "cn=9" in later


def test_new_params_are_forwarded_on_later_visits(
    make_settings: Callable[..., Settings],
) -> None:
    studies = [
        Study(
            url="https://example.com/a",
            weight=1,
            required_params=["email"],
            key_params=["email"],
        ),
    ]
    settings = make_settings(studies)

    get_or_create_redirect(
        settings.lookup_dir, studies, FALLBACK, {"email": ["a@b.com"]}
    )
    later = get_or_create_redirect(
        settings.lookup_dir,
        studies,
        FALLBACK,
        {"email": ["a@b.com"], "utm_source": ["news"]},
    )

    assert later.startswith("https://example.com/a")
    assert "utm_source=news" in later


def test_legacy_all_params_mappings_are_honored(
    make_settings: Callable[..., Settings],
) -> None:
    """A mapping stored under the old all-params scheme wins over
    re-randomization, even when a study now keys on a subset."""
    studies = [
        Study(
            url="https://example.com/new",
            weight=1,
            required_params=["email"],
            key_params=["email"],
        ),
    ]
    settings = make_settings(studies)
    params = {"email": ["foo@bar.com"], "ts": ["12345"]}

    legacy_destination = "https://example.com/legacy?email=foo%40bar.com&ts=12345"
    legacy_file = settings.lookup_dir / compute_hash(params)
    legacy_file.write_text(legacy_destination + "\n")

    result = get_or_create_redirect(settings.lookup_dir, studies, FALLBACK, params)

    assert result.startswith("https://example.com/legacy")
    assert "email=foo%40bar.com" in result
    assert "ts=12345" in result


def test_fallback_mappings_are_stable(
    make_settings: Callable[..., Settings],
) -> None:
    settings = make_settings([])
    params = {"id": ["123"]}

    first = get_or_create_redirect(settings.lookup_dir, [], FALLBACK, params)
    second = get_or_create_redirect(settings.lookup_dir, [], FALLBACK, params)

    assert first == second
    assert first.startswith(FALLBACK.url)
