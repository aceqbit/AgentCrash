"""Render the Results section of README.md from files in results/. Never types a number by hand."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"
START, END = "<!-- results:start -->", "<!-- results:end -->"


def latest(pattern: str) -> tuple[Path, dict] | None:
    files = sorted(RESULTS.glob(pattern))
    if not files:
        return None
    return files[-1], json.loads(files[-1].read_text(encoding="utf-8"))


def table(rows: list[list[object]], head: list[str]) -> str:
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def sweep_block(title: str, found: tuple[Path, dict] | None) -> str:
    if not found:
        return f"### {title}\n\nNo result file yet. Run the command above.\n"
    path, rep = found
    s = rep["summary"]
    rows = [
        [
            "points",
            s["points"],
        ],
        ["duplicates", s["duplicates"]],
        ["lost", s["lost"]],
        ["unknown surfaced", s["unknown"]],
        ["recovery p50 (ms)", s.get("p50_recovery_ms", "n/a")],
        ["recovery p95 (ms)", s["p95_recovery_ms"]],
        ["recovery max (ms)", s["max_recovery_ms"]],
    ]
    detail = [
        [r["step"], r["point"], r["crashed"], r["duplicates"], r["lost"], r["unknown"], r["pass"]]
        for r in rep["rows"]
    ]
    return (
        f"### {title}\n\nSource: `results/{path.name}` (git `{rep['git_sha'][:10]}`).\n\n"
        + table(rows, ["metric", "value"])
        + "\n\n<details><summary>Every point</summary>\n\n"
        + table(detail, ["step", "point", "crashed", "dup", "lost", "unknown", "pass"])
        + "\n\n</details>\n"
    )


def generic_block(title: str, pattern: str, keys: list[str]) -> str:
    found = latest(pattern)
    if not found:
        return ""
    path, data = found
    src = data.get("summary", data)
    rows = [[k, src[k]] for k in keys if k in src]
    return (
        f"### {title}\n\nSource: `results/{path.name}`.\n\n" + table(rows, ["metric", "value"]) + "\n"
    )


def render() -> str:
    parts = [
        sweep_block("Crash sweep (safe)", _safe()),
        sweep_block("Crash sweep (second kill during recovery)", latest("sweep_*_double_*.json")),
        sweep_block("Crash sweep (unsafe mode, expected to fail)", latest("sweep_*_unsafe_*.json")),
        generic_block("Security tests", "security_*.json", ["total", "blocked", "failed"]),
        generic_block(
            "Fuzz", "fuzz_*.json", ["scenarios", "failures", "seed", "max_recovery_ms"]
        ),
        generic_block(
            "Load", "load_*.json", ["runs", "completed", "waiting_unknown", "kills", "duplicates", "lost", "unknown", "recovery_p50_ms", "recovery_p95_ms", "recovery_max_ms"]
        ),
    ]
    bench = latest("bench_*.json")
    if bench:
        path, b = bench
        rows = []
        for phase in ("before", "after"):
            p = b.get(phase)
            if p:
                rows.append([phase, p["journal_p50_ms"], p["journal_p95_ms"], p["passthrough_p50_ms"],
                             p["passthrough_p95_ms"], p["overhead_p50_ms"], p["overhead_p95_ms"]])
        parts.append(
            f"### Journal overhead\n\nSource: `results/{path.name}` (git `{b['git_sha'][:10]}`), "
            f"{b['calls']} calls per mode.\n\n"
            + table(rows, ["run", "journal p50", "journal p95", "passthrough p50", "passthrough p95",
                           "overhead p50", "overhead p95"])
            + "\n"
        )
    return "\n".join(p for p in parts if p)


def _safe() -> tuple[Path, dict] | None:
    files = [f for f in sorted(RESULTS.glob("sweep_*.json")) if "_unsafe_" not in f.name]
    files = [f for f in files if "double" not in f.name]
    if not files:
        return None
    return files[-1], json.loads(files[-1].read_text(encoding="utf-8"))


def fill(path: Path, body: str) -> None:
    text = path.read_text(encoding="utf-8")
    if START not in text or END not in text:
        raise SystemExit(f"{path.name} is missing the results markers")
    head, rest = text.split(START, 1)
    _, tail = rest.split(END, 1)
    nl = chr(10)
    path.write_text(f"{head}{START}{nl}{nl}{body}{nl}{END}{tail}", encoding="utf-8")


def main() -> None:
    body = render()
    fill(ROOT / "README.md", body)
    writeup = ROOT / "docs" / "WRITEUP.md"
    if writeup.exists():
        fill(writeup, body)
    print("results sections regenerated")


if __name__ == "__main__":
    main()
