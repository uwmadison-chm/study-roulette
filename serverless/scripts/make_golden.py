"""
Generate test/golden.json from the Python implementation, so the TypeScript
port can prove it parses, hashes, and merges byte-for-byte the same way.

    cd .. && uv run python serverless/scripts/make_golden.py > serverless/test/golden.json
"""

import json
import sys
from urllib.parse import parse_qsl

from study_roulette.redirect import compute_hash, merge_urls

QUERIES = [
    "email=foo%40bar.com&ts=12345",
    "email=foo@bar.com&ts=1769010749&cn=2772222584",
    "a=1&a=2&b=",
    "v=b&v=a&v=c",
    "flag",
    "=nameless",
    "a=1&&b=2&",
    "q=hello+world&r=a%2Bb&s=%20",
    "name=%C3%A9t%C3%A9",
    "emoji=%F0%9F%98%80&cjk=%E4%B8%AD%E6%96%87",
    "%F0%9F%98%80=astral&%EF%BF%BF=bmp-max&z=ascii",
    "v=%F0%9F%98%80&v=%EF%BF%BF&v=a",
    "bad=%C3&worse=%ZZ&latin=%E9&trunc=%E4%B8",
    "ctrl=%00%01%1F%7F&nl=a%0Ab%0Dc%09d",
    "q=%22quoted%22&b=back%5Cslash",
    "mixed=%C3%A9%C3",
    "email=Foo%40Bar.com&EMAIL=x",
    "a=1;b=2",
    "tilde=~&star=*&paren=()&slash=/&colon=:",
]

BASES = [
    "https://example.com/survey?s=abc",
    "https://redcap.example.edu/surveys/?s=12345678",
    "https://ex.com/p;x?q=1&s=2#frag",
    "HTTPS://Ex.com/a",
    "https://e.com/?email=stored%40x.com&a=9",
    "https://e.com/a?",
    "https://e.com/a#",
    "https://e.com/a?empty=&dup=1&dup=2",
]


def params_of(query: str) -> dict[str, list[str]]:
    # Same as the FastAPI app's query_params(): parse_qsl(keep_blank_values=True)
    params: dict[str, list[str]] = {}
    for key, value in parse_qsl(query, keep_blank_values=True):
        params.setdefault(key, []).append(value)
    return params


cases = []
for query in QUERIES:
    params = params_of(query)
    cases.append(
        {
            "query": query,
            "params": [[k, v] for k, v in params.items()],
            "hash": compute_hash(params),
            "merges": [{"base": b, "result": merge_urls(b, params)} for b in BASES],
        }
    )

json.dump({"cases": cases}, sys.stdout, indent=1, ensure_ascii=False)
sys.stdout.write("\n")
