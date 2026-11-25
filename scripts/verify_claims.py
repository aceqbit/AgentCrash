"""Check that every number in README.md and docs/WRITEUP.md comes from a file in results/.

Numbers that are identifiers rather than measurements are skipped: P1..P4, E1..E5, step numbers
inside code spans, versions of tools, dates, git SHAs, ports and section references. Everything
else must appear as a value in a results/*.json file (or be a git SHA prefix recorded there).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"
DOCS = [ROOT / "README.md", ROOT / "docs" / "WRITEUP.md"]


def numbers_in_results() -> tuple[set[str], set[str]]:
    nums: set[str] = set()
    shas: set[str] = set()

    def walk(v: object, key: str = "") -> None:
        if isinstance(v, bool):
            return
        if isinstance(v, (int, float)):
            nums.add(_norm(v))
            if isinstance(v, float) and v == int(v):
                nums.add(str(int(v)))
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, k)
        elif isinstance(v, list):
            nums.add(str(len(v)))  # row counts such as "20 rows"
            for x in v:
                walk(x, key)
        elif isinstance(v, str) and key == "git_sha":
            shas.add(v)

    for f in sorted(RESULTS.glob("*.json")):
        walk(json.loads(f.read_text(encoding="utf-8")))
    return nums, shas


def _norm(v: int | float) -> str:
    return str(int(v)) if isinstance(v, float) and v == int(v) else str(v)


FENCE = re.compile(r"```.*?```", re.S)
SPAN = re.compile(r"`[^`\n]*`")
LINK = re.compile(r"\]\([^)]*\)|https?://\S+")
DETAILS = re.compile(r"<details>.*?</details>", re.S)  # per-point tables are generated, same source
COMMENT = re.compile(r"<!--.*?-->", re.S)
IDENT = re.compile(r"\b[A-Za-z]+\d+\b|\b\d+[A-Za-z]+\b|\b\d{4}-\d{2}-\d{2}\b|\b[0-9a-f]{7,40}\b")
CONTEXT = re.compile(
    r"\b(?:Node|Python|PostgreSQL|Postgres|Windows|OAuth|ES|section|sections|Phase|prompt|prompts|step|steps|P|E)\s+\d+(?:\.\d+)*\+?",
    re.I,
)
NUM = re.compile(r"(?<![\w.])\d+(?:\.\d+)?(?![\w])")


def claims_in(text: str) -> list[str]:
    text = COMMENT.sub(" ", FENCE.sub(" ", text))
    text = LINK.sub(" ", SPAN.sub(" ", text))
    text = CONTEXT.sub(" ", IDENT.sub(" ", text))
    return NUM.findall(text)


def main() -> int:
    nums, shas = numbers_in_results()
    bad: list[tuple[str, str]] = []
    checked = 0
    for doc in DOCS:
        if not doc.exists():
            continue
        text = doc.read_text(encoding="utf-8")
        for n in claims_in(DETAILS.sub(" ", text)):
            checked += 1
            if n not in nums:
                bad.append((doc.name, n))
        for sha in re.findall(r"`([0-9a-f]{7,40})`", text):
            checked += 1
            if not any(s.startswith(sha) for s in shas):
                bad.append((doc.name, sha))
    if bad:
        print("numbers not found in results/:")
        for d, n in bad:
            print(f"  {d}: {n}")
        return 1
    print(f"verify_claims: {checked} numbers checked, all found in results/")
    return 0


if __name__ == "__main__":
    sys.exit(main())

