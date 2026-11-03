"""
One-time conversion of a Python-era studies.toml to studies.json.

    python3 scripts/toml_to_json.py path/to/studies.toml > studies.json

Standard library only. Adds a fresh random seed, and derives each study's
name (used in the randomization log) from its note; check the names.
"""

import json
import re
import secrets
import sys
import tomllib


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:64]


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1], "rb") as f:
        data = tomllib.load(f)

    keep = ("url", "weight", "note", "required_params", "key_params")
    studies = []
    used = {"fallback"}  # the fallback's default name
    for i, entry in enumerate(data.get("studies", [])):
        # Names identify studies in the randomization log; derive them from
        # notes where possible. Review and rename in the configurator.
        base = slug(str(entry.get("note", ""))) or f"study-{i + 1}"
        name, n = base, 2
        while name in used:
            name, n = f"{base}-{n}", n + 1
        used.add(name)
        study = {"name": name}
        study.update({k: entry[k] for k in keep if k in entry})
        study.setdefault("required_params", [])
        studies.append(study)

    fallback = {"name": "fallback"}
    fallback.update({k: data["fallback"][k] for k in ("url", "note") if k in data["fallback"]})
    out = {"seed": secrets.token_hex(16), "studies": studies, "fallback": fallback}
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
