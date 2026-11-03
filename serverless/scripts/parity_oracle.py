"""
Line-oriented oracle for the parity property test: reads one JSON request per
line on stdin and writes the Python implementation's answer as one JSON line.

Request:  {"query": "...", "bases": ["https://...", ...]}
Response: {"params": [[name, [values]], ...], "hash": "...", "merges": ["...", ...]}

Run from the repo root so study_roulette is importable:
    uv run python serverless/scripts/parity_oracle.py
"""

import json
import sys
from urllib.parse import parse_qsl

from study_roulette.redirect import compute_hash, merge_urls


def answer(request: dict) -> dict:
    # Same as the FastAPI app's query_params(): parse_qsl(keep_blank_values=True)
    params: dict[str, list[str]] = {}
    for key, value in parse_qsl(request["query"], keep_blank_values=True):
        params.setdefault(key, []).append(value)
    return {
        "params": [[k, v] for k, v in params.items()],
        "hash": compute_hash(params),
        "merges": [merge_urls(b, params) for b in request["bases"]],
    }


for line in sys.stdin:
    try:
        out = answer(json.loads(line))
    except Exception as e:  # report, don't die: the test shows the input
        out = {"error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
