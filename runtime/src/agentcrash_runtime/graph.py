from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from .gateway_client import GatewayClient, ToolRejected
from .model import Model
from .scenarios import Scenario, load_scenario


class AgentState(TypedDict):
    run_id: str
    scenario: str
    step_no: int
    pending: dict[str, Any] | None
    history: list[dict[str, Any]]
    failed: bool


def build_graph(gw: GatewayClient, model: Model, checkpointer: Any) -> Any:
    cache: dict[str, Scenario] = {}

    def scen(name: str) -> Scenario:
        if name not in cache:
            cache[name] = load_scenario(name)
        return cache[name]

    async def plan(state: AgentState) -> dict[str, Any]:
        step = await model.next_action(scen(state["scenario"]), state["step_no"], state["history"])
        return {"pending": step.to_call() if step else None}

    async def call_tool(state: AgentState) -> dict[str, Any]:
        call = state["pending"]
        assert call is not None
        try:
            result = await gw.call_tool(state["run_id"], state["step_no"], call)
        except ToolRejected:
            return {"failed": True, "pending": None}
        hist = [
            *state["history"],
            {
                "id": f"toolu_{state['step_no']}",
                "tool": call["tool"],
                "args": call["args"],
                "result": result,
            },
        ]
        return {"step_no": state["step_no"] + 1, "history": hist, "pending": None}

    async def finish(state: AgentState) -> dict[str, Any]:
        await gw.finish_run(state["run_id"], "FAILED" if state["failed"] else "DONE")
        return {}

    def after_plan(state: AgentState) -> str:
        return "call_tool" if state["pending"] else "finish"

    def after_call(state: AgentState) -> str:
        return "finish" if state["failed"] else "plan"

    g = StateGraph(AgentState)
    g.add_node("plan", plan)
    g.add_node("call_tool", call_tool)
    g.add_node("finish", finish)
    g.set_entry_point("plan")
    g.add_conditional_edges("plan", after_plan, {"call_tool": "call_tool", "finish": "finish"})
    g.add_conditional_edges("call_tool", after_call, {"plan": "plan", "finish": "finish"})
    g.add_edge("finish", END)
    return g.compile(checkpointer=checkpointer)
