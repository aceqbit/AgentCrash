import asyncio

from agentcrash_runtime.graph import build_graph
from agentcrash_runtime.model import ScriptedModel
from agentcrash_runtime.scenarios import load_scenario


def test_bank_5_loads_five_steps() -> None:
    s = load_scenario("bank_5")
    assert [x.tool for x in s.steps] == [
        "transfer",
        "create_ticket",
        "send_email",
        "transfer",
        "send_email",
    ]
    assert [x.idempotent for x in s.steps] == [True, True, False, True, False]
    assert s.steps[2].probe == "list_sent_emails"
    assert s.steps[4].probe is None
    assert s.steps[1].requires_approval is True


def test_scripted_model_is_deterministic_and_stops() -> None:
    s = load_scenario("bank_5")
    m = ScriptedModel()

    async def run() -> list[str | None]:
        out: list[str | None] = []
        for i in range(7):
            a = await m.next_action(s, i, [])
            out.append(a.tool if a else None)
        return out

    first = asyncio.run(run())
    assert first == asyncio.run(run())
    assert first == [
        "transfer",
        "create_ticket",
        "send_email",
        "transfer",
        "send_email",
        None,
        None,
    ]


def test_graph_has_plan_call_tool_finish() -> None:
    g = build_graph(object(), ScriptedModel(), None)  # type: ignore[arg-type]
    names = set(g.get_graph().nodes)
    assert {"plan", "call_tool", "finish"} <= names


def test_unknown_scenario_name_rejected() -> None:
    import pytest

    with pytest.raises(ValueError):
        load_scenario("../etc/passwd")
