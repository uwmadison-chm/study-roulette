"""
One-time conversion of a Python-era studies.toml to studies.json.

    python3 scripts/toml_to_json.py path/to/studies.toml > studies.json

Standard library only. Adds a fresh random seed.
"""

import json
import secrets
import sys
import tomllib


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1], "rb") as f:
        data = tomllib.load(f)

    keep = ("url", "weight", "note", "required_params", "key_params")
    studies = []
    for entry in data.get("studies", []):
        study = {k: entry[k] for k in keep if k in entry}
        study.setdefault("required_params", [])
        studies.append(study)

    fallback = {k: data["fallback"][k] for k in ("url", "note") if k in data["fallback"]}
    out = {"seed": secrets.token_hex(16), "studies": studies, "fallback": fallback}
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
