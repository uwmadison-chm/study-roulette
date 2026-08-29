import json
from collections.abc import Callable
from pathlib import Path

import pytest

from study_roulette.settings import Settings
from study_roulette.studies import Study

FALLBACK_URL = "https://example.com/fallback"


@pytest.fixture
def make_settings(tmp_path: Path) -> Callable[..., Settings]:
    """
    Factory fixture that creates Settings with a studies file.

    Usage:
        def test_something(make_settings):
            settings = make_settings([
                Study(url="https://example.com/a", weight=1),
                Study(url="https://example.com/b", weight=2),
            ])

    A fallback section is always written (pointing at FALLBACK_URL unless
    overridden); pass fallback_url=None to omit it.
    """

    def _make_settings(
        studies: list[Study], fallback_url: str | None = FALLBACK_URL
    ) -> Settings:
        lookup_dir = tmp_path / "lookups"
        lookup_dir.mkdir(exist_ok=True)

        studies_file = tmp_path / "studies.toml"

        lines = []
        for s in studies:
            parts = [f'url = "{s.url}"', f"weight = {s.weight}"]
            if s.note is not None:
                parts.append(f'note = "{s.note}"')
            if s.required_params:
                # JSON string arrays are valid TOML arrays
                parts.append(f"required_params = {json.dumps(s.required_params)}")
            if s.key_params is not None:
                parts.append(f"key_params = {json.dumps(s.key_params)}")
            lines.append("    {" + ", ".join(parts) + "}")

        if lines:
            content = "studies = [\n" + ",\n".join(lines) + ",\n]\n"
        else:
            content = "studies = []\n"
        if fallback_url is not None:
            content += f'\n[fallback]\nurl = "{fallback_url}"\n'
        studies_file.write_text(content)

        return Settings(lookup_dir=lookup_dir, studies_file=studies_file)

    return _make_settings
