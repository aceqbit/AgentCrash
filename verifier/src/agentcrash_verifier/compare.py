from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .scenario import Scenario, canonical_json

Sig = tuple[str, str]


def sig(tool: str, args: dict[str, Any]) -> Sig:
    return (tool, canonical_json(args))


@dataclass
class Comparison:
    duplicates: int
    lost: int
    duplicate_tools: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.duplicates == 0 and self.lost == 0


def compare(
    scenario: Scenario, effects: list[dict[str, Any]], unknown_step: int | None
) -> Comparison:
    """Compare mock-server effects with the scenario's intended effects.

    Ground truth is the mock servers' effect log only. A call left UNKNOWN may have happened at
    most once, and steps after it are not required (the run waits for an operator).
    """
    required: Counter[Sig] = Counter()
    optional: Counter[Sig] = Counter()
    for i, s in enumerate(scenario.steps):
        if unknown_step is not None and i > unknown_step:
            break
        (optional if i == unknown_step else required)[sig(s.tool, s.args)] += 1
    actual: Counter[Sig] = Counter(sig(e["tool"], e["args"]) for e in effects)
    dup_tools: list[str] = []
    dups = lost = 0
    for k in set(actual) | set(required) | set(optional):
        allowed = required[k] + optional[k]
        if actual[k] > allowed:
            dups += actual[k] - allowed
            dup_tools += [k[0]] * (actual[k] - allowed)
        if actual[k] < required[k]:
            lost += required[k] - actual[k]
    return Comparison(dups, lost, sorted(dup_tools))
