from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

SCENARIO_DIR = Path(
    os.environ.get("SCENARIO_DIR") or Path(__file__).resolve().parents[2] / "scenarios"
)
IDEMPOTENT = {"transfer", "create_ticket"}


def canonical_json(v: Any) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def idempotency_key(run_id: str, step_no: int, tool: str, args: dict[str, Any]) -> str:
    raw = f"{run_id}:{step_no}:{tool}:{canonical_json(args)}"
    return hashlib.sha256(raw.encode()).hexdigest()


@dataclass(frozen=True)
class Step:
    tool: str
    args: dict[str, Any]
    idempotent: bool
    probe: str | None
    requires_approval: bool


@dataclass(frozen=True)
class Scenario:
    name: str
    seed: int
    steps: list[Step] = field(default_factory=list)


def parse_scenario(doc: dict[str, Any]) -> Scenario:
    steps = [
        Step(
            s["tool"],
            s.get("args", {}),
            bool(s.get("idempotent", s["tool"] in IDEMPOTENT)),
            s.get("probe"),
            bool(s.get("requires_approval", False)),
        )
        for s in doc["steps"]
    ]
    return Scenario(doc["name"], int(doc.get("seed", 0)), steps)


def load_scenario(name: str, directory: Path | None = None) -> Scenario:
    d = directory or Path(
        os.environ.get("SCENARIO_DIR") or Path(__file__).resolve().parents[2] / "scenarios"
    )
    return parse_scenario(yaml.safe_load((d / f"{name}.yaml").read_text(encoding="utf-8")))
