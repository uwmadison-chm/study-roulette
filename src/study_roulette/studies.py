from functools import lru_cache
import logging
import random
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


@dataclass
class Study:
    url: str
    weight: float
    note: str | None = None
    # Parameter names that must all be present in a URL for this study to be
    # eligible. A parameter that is present but blank counts as present.
    required_params: list[str] = field(default_factory=list)
    # The subset of required_params used to key persistent randomization.
    # None means "key on all supplied parameters" (the pre-required_params behavior).
    key_params: list[str] | None = None


@dataclass
class Fallback:
    url: str
    note: str | None = None


@dataclass
class ParseResult:
    studies: list["Study"]
    fallback: Fallback | None
    errors: list[str]


class StudiesFileError(Exception):
    """Raised when the studies file cannot be read at all."""

    pass


def parse_url(entry: dict[str, Any], label: str) -> str:
    if "url" not in entry:
        raise StudiesFileError(f"{label}: missing required key 'url'")

    url_str = entry["url"]
    if not isinstance(url_str, str):
        raise StudiesFileError(f"{label}: 'url' must be a string")

    parsed = urlparse(url_str)
    if not parsed.scheme or not parsed.netloc:
        raise StudiesFileError(f"{label}: invalid URL '{url_str}'")

    return url_str


def parse_param_list(entry: dict[str, Any], key: str, label: str) -> list[str] | None:
    if key not in entry:
        return None

    value = entry[key]
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise StudiesFileError(f"{label}: '{key}' must be an array of strings")

    return value


def parse_study_entry(entry: Any, index: int) -> Study:
    """Parse a single study entry from TOML, raising StudiesFileError on failure."""
    label = f"studies[{index}]"
    if not isinstance(entry, dict):
        raise StudiesFileError(f"{label}: expected a table, got {type(entry).__name__}")

    url_str = parse_url(entry, label)

    if "weight" not in entry:
        raise StudiesFileError(f"{label}: missing required key 'weight'")

    weight = entry["weight"]
    if not isinstance(weight, (int, float)):
        raise StudiesFileError(f"{label}: 'weight' must be a number")

    if weight < 0:
        raise StudiesFileError(f"{label}: weight must be non-negative, got {weight}")

    note = entry.get("note")
    if note is not None:
        note = str(note)

    required_params = parse_param_list(entry, "required_params", label) or []
    key_params = parse_param_list(entry, "key_params", label)

    if key_params is not None:
        missing = [p for p in key_params if p not in required_params]
        if missing:
            raise StudiesFileError(
                f"{label}: key_params must be a subset of required_params, "
                f"but {missing} are not in required_params"
            )

    return Study(
        url=url_str,
        weight=float(weight),
        note=note,
        required_params=required_params,
        key_params=key_params,
    )


def parse_fallback_entry(entry: Any) -> Fallback:
    """Parse the fallback table from TOML, raising StudiesFileError on failure."""
    if not isinstance(entry, dict):
        raise StudiesFileError(
            f"fallback: expected a table, got {type(entry).__name__}"
        )

    # The fallback is always eligible and always keyed on all supplied
    # parameters, so these keys would be misleading if we silently ignored them
    for forbidden in ("weight", "required_params", "key_params"):
        if forbidden in entry:
            raise StudiesFileError(f"fallback: must not have '{forbidden}'")

    url_str = parse_url(entry, "fallback")

    note = entry.get("note")
    if note is not None:
        note = str(note)

    return Fallback(url=url_str, note=note)


# We cache this not because it is hard, but because it is trivial
def parse_studies_file(path: Path) -> ParseResult:
    try:
        mtime = path.stat().st_mtime_ns
    except Exception as e:
        raise StudiesFileError(f"Cannot read studies file: {e}")
    return _parse_studies_file(mtime, path)


@lru_cache(maxsize=1)
def _parse_studies_file(mtime: int, path: Path) -> ParseResult:
    """
    Parse a TOML studies file and return valid studies, the fallback, and any errors.

    Expected format:
        studies = [
            {url = "https://example.com/study1", weight = 1},
            {url = "https://example.com/study2", weight = 2,
             required_params = ["email"], key_params = ["email"]},
        ]

        [fallback]
        url = "https://example.com/registry"

    Fatal errors (can't read file, invalid TOML, missing studies key) raise StudiesFileError.
    Individual study parsing errors are returned in ParseResult.errors alongside valid studies.
    A missing or invalid fallback is an error, but studies are still returned.
    """
    logger.debug("Parsing studies file: %s", path)
    try:
        content = path.read_bytes()
    except OSError as e:
        raise StudiesFileError(f"Cannot read studies file: {e}")

    try:
        data = tomllib.loads(content.decode("utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise StudiesFileError(f"Invalid TOML: {e}")

    if "studies" not in data:
        raise StudiesFileError("Missing required key 'studies'")

    studies_data = data["studies"]
    if not isinstance(studies_data, list):
        raise StudiesFileError("'studies' must be an array")

    studies: list[Study] = []
    errors: list[str] = []

    for i, entry in enumerate(studies_data):
        try:
            studies.append(parse_study_entry(entry, i))
        except StudiesFileError as e:
            errors.append(str(e))

    fallback: Fallback | None = None
    if "fallback" not in data:
        errors.append("Missing required 'fallback' table")
    else:
        try:
            fallback = parse_fallback_entry(data["fallback"])
        except StudiesFileError as e:
            errors.append(str(e))

    logger.debug("Loaded %d studies from %s", len(studies), path.name)
    return ParseResult(studies=studies, fallback=fallback, errors=errors)


def eligible_studies(
    studies: list[Study], params: dict[str, list[str]]
) -> list[Study]:
    """
    Studies whose required_params are all present in params.

    A parameter that is present but blank counts as present.
    """
    return [s for s in studies if all(p in params for p in s.required_params)]


def choose_study(studies: list[Study]) -> Study:
    """
    Choose a random study from the list using weighted selection.

    Studies with weight 0 are excluded from selection.
    """
    eligible = [s for s in studies if s.weight > 0]
    if not eligible:
        raise ValueError("No eligible studies with positive weight")

    weights = [s.weight for s in eligible]
    chosen = random.choices(eligible, weights=weights, k=1)[0]
    logger.debug(
        "Selected study %s (weight %.2f) from %d eligible studies",
        chosen.url,
        chosen.weight,
        len(eligible),
    )
    return chosen
