from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

# Defaults for tools the scenario does not describe fully.
TOOL_DEFAULTS: dict[str, dict[str, Any]] = {
    "transfer": {"idempotent": True, "probe": None},
    "create_ticket": {"idempotent": True, "probe": None},
    "get_balance": {"idempotent": True, "probe": None},
    "send_email": {"idempotent": False, "probe": "list_sent_emails"},
}


@dataclass(frozen=True)
class Step:
    tool: str
    args: dict[str, Any]
    idempotent: bool
    probe: str | None
    requires_approval: bool = False

    def to_call(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "args": self.args,
            "probe": self.probe,
            "requires_approval": self.requires_approval,
        }


@dataclass(frozen=True)
class Scenario:
    name: str
    seed: int
    steps: list[Step] = field(default_factory=list)
    goal: str = ""


def scenario_dir() -> Path:
    env = os.environ.get("SCENARIO_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[3] / "verifier" / "scenarios"


def parse_scenario(doc: dict[str, Any]) -> Scenario:
    steps: list[Step] = []
    for raw in doc["steps"]:
        d = TOOL_DEFAULTS.get(raw["tool"], {"idempotent": False, "probe": None})
        steps.append(
            Step(
                tool=raw["tool"],
                args=raw["args"],
                idempotent=bool(raw.get("idempotent", d["idempotent"])),
                probe=raw["probe"] if "probe" in raw else d["probe"],
                requires_approval=bool(raw.get("requires_approval", False)),
            )
        )
    return Scenario(
        name=doc["name"], seed=int(doc.get("seed", 0)), steps=steps, goal=doc.get("goal", "")
    )


def load_scenario(name: str) -> Scenario:
    if not name.replace("_", "").replace("-", "").isalnum():
        raise ValueError(f"bad scenario name: {name!r}")
    path = scenario_dir() / f"{name}.yaml"
    with path.open(encoding="utf-8") as fh:
        return parse_scenario(yaml.safe_load(fh))
