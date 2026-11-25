from __future__ import annotations

import hashlib
import json
import os
import random
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from hypothesis import HealthCheck, Phase, given, seed, settings
from hypothesis import strategies as st

from . import supervisor as sup
from .scenario import Scenario, parse_scenario
from .sweep import POINTS, _git_sha, record_oracle, run_point

REGRESSIONS = Path(__file__).resolve().parents[2] / "regressions"

ACCOUNTS = ["A", "B", "C"]
WORDS = ["review", "audit", "refund", "close", "open", "renew"]


def _step_st() -> st.SearchStrategy[dict[str, Any]]:
    transfer = st.builds(
        lambda f, t, a, ap: {
            "tool": "transfer",
            "args": {"from": f, "to": t, "amount": a},
            "idempotent": True,
            "requires_approval": ap,
        },
        st.sampled_from(ACCOUNTS),
        st.sampled_from(ACCOUNTS),
        st.integers(1, 20),
        st.booleans(),
    )
    ticket = st.builds(
        lambda w, ap: {
            "tool": "create_ticket",
            "args": {"title": w},
            "idempotent": True,
            "requires_approval": ap,
        },
        st.sampled_from(WORDS),
        st.booleans(),
    )
    email = st.builds(
        lambda to, subj, probe, ap: {
            "tool": "send_email",
            "args": {"to": f"{to}@example.test", "subject": subj},
            "idempotent": False,
            "probe": "list_sent_emails" if probe else None,
            "requires_approval": ap,
        },
        st.sampled_from(["ops", "finance", "audit"]),
        st.sampled_from(WORDS),
        st.booleans(),
        st.booleans(),
    )
    return st.one_of(transfer, ticket, email)


@st.composite
def case_st(draw: st.DrawFn) -> dict[str, Any]:
    steps = draw(st.lists(_step_st(), min_size=2, max_size=8))
    return {
        "steps": steps,
        "crash": {
            "step": draw(st.integers(0, len(steps) - 1)),
            "point": draw(st.sampled_from(POINTS)),
            "double": draw(st.booleans()),
        },
    }


def case_name(case: dict[str, Any]) -> str:
    return "fuzz_" + hashlib.sha256(json.dumps(case, sort_keys=True).encode()).hexdigest()[:10]


def case_doc(case: dict[str, Any]) -> dict[str, Any]:
    return {"name": case_name(case), "seed": 0, **case}


def write_scenario(directory: Path, case: dict[str, Any]) -> Scenario:
    doc = case_doc(case)
    (directory / f"{doc['name']}.yaml").write_text(yaml.safe_dump(doc), encoding="utf-8")
    return parse_scenario(doc)


def save_regression(case: dict[str, Any], detail: str) -> Path:
    REGRESSIONS.mkdir(parents=True, exist_ok=True)
    path = REGRESSIONS / f"{case_name(case)}.yaml"
    doc = {**case_doc(case), "failure": detail}
    path.write_text(yaml.safe_dump(doc), encoding="utf-8")
    return path


def run_case(directory: Path, case: dict[str, Any]) -> tuple[bool, str, int]:
    scenario = write_scenario(directory, case)
    name = case_name(case)
    c = case["crash"]
    row = run_point(scenario, name, c["step"], c["point"], False, bool(c["double"]))
    detail = (
        f"{name} step={c['step']} point={c['point']} double={c['double']} "
        f"dup={row.duplicates}({row.duplicate_tools}) lost={row.lost} end={row.end_status}"
    )
    return row.ok, detail, row.recovery_ms


def fuzz(n: int, seed_value: int | None, out_dir: Path) -> tuple[Path, dict[str, Any]]:
    seed_value = seed_value if seed_value is not None else random.SystemRandom().randrange(2**31)
    print(f"fuzz seed: {seed_value}  (replay with --seed {seed_value})", flush=True)
    started = datetime.now(UTC)
    tmp = Path(tempfile.mkdtemp(prefix="agentcrash-fuzz-"))
    os.environ["SCENARIO_DIR"] = str(tmp)
    sup.kill_pidfiles()
    mock = sup.start_mock()
    auth = sup.start_auth() if sup.AUTH else None
    boot = sup.start_gateway()
    runtime = sup.start_runtime()
    sup.stop(boot)
    stats: dict[str, Any] = {"ran": 0, "recovery": [], "failure": None}

    @seed(seed_value)
    @settings(
        max_examples=n,
        deadline=None,
        database=None,
        phases=[Phase.generate, Phase.shrink],
        suppress_health_check=list(HealthCheck),
    )
    @given(case_st())
    def prop(case: dict[str, Any]) -> None:
        stats["ran"] += 1
        t0 = time.time()
        ok, detail, rec = run_case(tmp, case)
        print(f"fuzz case {stats['ran']}: {detail} [{time.time() - t0:.1f}s]", flush=True)
        if rec:
            stats["recovery"].append(rec)
        if not ok:
            stats["failure"] = (case, detail)  # the last failing call is the shrunk example
            raise AssertionError(detail)
        if stats["ran"] % 25 == 0:
            print(f"fuzz: {stats['ran']} cases ok", flush=True)

    failed_path: Path | None = None
    try:
        record_oracle(parse_scenario(yaml.safe_load(_oracle_doc())), "fuzz_oracle")
        prop()
    except AssertionError:
        case, detail = stats["failure"]
        failed_path = save_regression(case, detail)
        print(f"FAILURE (shrunk): {detail}\nsaved {failed_path}", flush=True)
    finally:
        sup.stop(runtime)
        sup.stop(mock)
        sup.stop(auth)
        sup.kill_pidfiles()
    rec = sorted(stats["recovery"])
    report = {
        "git_sha": _git_sha(),
        "started": started.isoformat(),
        "seed": seed_value,
        "requested": n,
        "scenarios": stats["ran"],
        "failures": 0 if failed_path is None else 1,
        "regression": str(failed_path) if failed_path else None,
        "max_recovery_ms": rec[-1] if rec else 0,
        "p95_recovery_ms": rec[max(0, -(-95 * len(rec) // 100) - 1)] if rec else 0,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"fuzz_{started.strftime('%Y%m%dT%H%M%SZ')}.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return path, report


def _oracle_doc() -> str:
    doc = {
        "name": "fuzz_oracle",
        "seed": 0,
        "steps": [{"tool": "transfer", "args": {"from": "A", "to": "B", "amount": 1}}],
    }
    (Path(os.environ["SCENARIO_DIR"]) / "fuzz_oracle.yaml").write_text(yaml.safe_dump(doc))
    return yaml.safe_dump(doc)


def replay(path: Path) -> bool:
    """Replay a saved regression file (fixed crash point, no randomness)."""
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    case = {"steps": doc["steps"], "crash": doc["crash"]}
    tmp = Path(tempfile.mkdtemp(prefix="agentcrash-replay-"))
    os.environ["SCENARIO_DIR"] = str(tmp)
    sup.kill_pidfiles()
    mock = sup.start_mock()
    boot = sup.start_gateway()
    runtime = sup.start_runtime()
    sup.stop(boot)
    try:
        ok, detail, _ = run_case(tmp, case)
        print(("ok: " if ok else "FAIL: ") + detail)
        return ok
    finally:
        sup.stop(runtime)
        sup.stop(mock)
        sup.kill_pidfiles()
