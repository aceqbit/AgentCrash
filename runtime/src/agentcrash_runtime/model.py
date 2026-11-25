from __future__ import annotations

import json
import os
from typing import Any, Protocol

import httpx

from .scenarios import Scenario, Step


class Model(Protocol):
    async def next_action(
        self, scenario: Scenario, step_no: int, history: list[Any]
    ) -> Step | None: ...


class ScriptedModel:
    """Deterministic fake model: returns the scenario's steps in order, then stops."""

    async def next_action(
        self, scenario: Scenario, step_no: int, history: list[Any]
    ) -> Step | None:
        if step_no >= len(scenario.steps):
            return None
        return scenario.steps[step_no]


class LiveModel:
    """Anthropic Messages API via httpx. Used only by `just demo`; never in tests."""

    URL = "https://api.anthropic.com/v1/messages"

    def __init__(self) -> None:
        self.key = os.environ["ANTHROPIC_API_KEY"]
        self.model = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-5-5")

    async def next_action(
        self, scenario: Scenario, step_no: int, history: list[Any]
    ) -> Step | None:
        from .scenarios import TOOL_DEFAULTS

        tools = [
            {
                "name": n,
                "description": f"Call {n}",
                "input_schema": {"type": "object", "additionalProperties": True},
            }
            for n in TOOL_DEFAULTS
        ]
        msgs: list[dict[str, Any]] = [{"role": "user", "content": scenario.goal or "Do the task."}]
        for h in history:
            msgs.append(
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": h["id"], "name": h["tool"], "input": h["args"]}
                    ],
                }
            )
            msgs.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": h["id"],
                            "content": json.dumps(h["result"]),
                        }
                    ],
                }
            )
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(
                self.URL,
                headers={"x-api-key": self.key, "anthropic-version": "2023-06-01"},
                json={"model": self.model, "max_tokens": 512, "tools": tools, "messages": msgs},
            )
            r.raise_for_status()
        for block in r.json()["content"]:
            if block["type"] == "tool_use":
                d = TOOL_DEFAULTS.get(block["name"], {"idempotent": False, "probe": None})
                return Step(block["name"], block["input"], d["idempotent"], d["probe"], False)
        return None


def make_model() -> Model:
    return LiveModel() if os.environ.get("RUNTIME_MODEL") == "live" else ScriptedModel()
