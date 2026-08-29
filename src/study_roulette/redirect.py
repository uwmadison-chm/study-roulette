import fcntl
import hashlib
import json
import logging
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from .studies import Fallback, Study, choose_study, eligible_studies

logger = logging.getLogger(__name__)


def compute_hash(params: dict[str, list[str]]) -> str:
    """
    Compute a stable SHA256 hash from URL parameters.

    Parameters are serialized as sorted JSON for stability. This format must
    stay byte-identical across releases: it's what keys every stored mapping.
    """
    # Sort the keys and sort the values within each key for stability
    sorted_params = {k: sorted(v) for k, v in sorted(params.items())}
    param_str = json.dumps(sorted_params, sort_keys=True)
    hash_value = hashlib.sha256(param_str.encode()).hexdigest()
    logger.debug("Computed hash %s for params: %s", hash_value[:12], sorted_params)
    return hash_value


def merge_urls(base_url: str, incoming_params: dict[str, list[str]]) -> str:
    """
    Merge incoming URL parameters into a base URL.

    Base URL parameters take precedence over incoming parameters.
    """
    parsed = urlparse(base_url)
    base_params = parse_qs(parsed.query, keep_blank_values=True)

    # Incoming params first, then base params override
    merged = dict(incoming_params)
    merged.update(base_params)

    # Rebuild the URL with merged parameters
    new_query = urlencode(merged, doseq=True)
    new_parsed = parsed._replace(query=new_query)
    result = urlunparse(new_parsed)
    logger.debug(
        "Merged %d incoming params into base URL %s",
        len(incoming_params),
        parsed.netloc,
    )
    return result


def key_subset(
    params: dict[str, list[str]], key_params: list[str] | None
) -> dict[str, list[str]] | None:
    """
    The subset of params a study keys its randomization on.

    None key_params means "key on all supplied parameters". Returns None if
    any key parameter is missing from params.
    """
    if key_params is None:
        return dict(params)
    if not all(k in params for k in key_params):
        return None
    return {k: params[k] for k in key_params}


def candidate_hashes(studies: list[Study], params: dict[str, list[str]]) -> list[str]:
    """
    Hashes to check for an existing mapping, in precedence order.

    Candidates are the all-params key (the fallback's key, and how every
    mapping predating key_params was stored) plus each study's key set where
    all of its key params are present. Most specific first (most parameter
    names), then study order, with the all-params key winning ties.
    """
    candidates = [(len(params), -1, compute_hash(params))]
    for i, study in enumerate(studies):
        if study.key_params is None:
            # Keys on all supplied params; already covered by the first candidate
            continue
        subset = key_subset(params, study.key_params)
        if subset is None:
            continue
        candidates.append((len(subset), i, compute_hash(subset)))

    candidates.sort(key=lambda c: (-c[0], c[1]))

    hashes: list[str] = []
    for _, _, hash_value in candidates:
        if hash_value not in hashes:
            hashes.append(hash_value)
    return hashes


def read_mapping(hash_file: Path) -> str | None:
    """Read a stored mapping, returning None if absent or empty."""
    try:
        f = open(hash_file)
    except FileNotFoundError:
        return None
    with f:
        try:
            fcntl.lockf(f, fcntl.LOCK_SH)
            content = f.read().strip()
        finally:
            fcntl.lockf(f, fcntl.LOCK_UN)
    return content or None


def get_or_create_redirect(
    lookup_dir: Path,
    studies: list[Study],
    fallback: Fallback,
    params: dict[str, list[str]],
) -> str:
    """
    Get an existing redirect URL or create a new one.

    A stored mapping always wins, and its parameters win over the current
    visit's: parameters missing from this visit are replayed from the stored
    URL, new ones are forwarded, conflicting ones keep their stored values.

    Uses file locking to prevent race conditions.
    """
    # Ensure lookup directory exists
    lookup_dir.mkdir(parents=True, exist_ok=True)

    for url_hash in candidate_hashes(studies, params):
        stored = read_mapping(lookup_dir / url_hash)
        if stored is not None:
            logger.debug("Cache hit for hash %s", url_hash[:12])
            return merge_urls(stored, params)

    # No existing mapping; randomize among eligible studies, or use the fallback
    eligible = [s for s in eligible_studies(studies, params) if s.weight > 0]
    if eligible:
        chosen = choose_study(eligible)
        # key_params is a subset of required_params, which eligibility
        # guarantees are all present, so this subset always exists
        storage_key = key_subset(params, chosen.key_params)
        assert storage_key is not None
        base_url = chosen.url
    else:
        logger.debug("No eligible studies, using fallback")
        storage_key = dict(params)
        base_url = fallback.url

    url_hash = compute_hash(storage_key)
    hash_file = lookup_dir / url_hash

    logger.debug("Opening hash file: %s", hash_file)
    with open(hash_file, "a+") as f:
        try:
            logger.debug("Acquiring exclusive lock on %s", hash_file.name)
            fcntl.lockf(f, fcntl.LOCK_EX)
            f.seek(0)
            content = f.read().strip()

            if content:
                # Another process created this mapping while we were choosing
                logger.debug("Cache hit for hash %s", url_hash[:12])
                return merge_urls(content, params)

            destination = merge_urls(base_url, params)
            f.write(destination + "\n")
            logger.debug("Created new redirect: %s -> %s", url_hash[:12], base_url)
            return destination
        finally:
            logger.debug("Releasing lock on %s", hash_file.name)
            fcntl.lockf(f, fcntl.LOCK_UN)
