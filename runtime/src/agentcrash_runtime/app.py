from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from pydantic import BaseModel

from .gateway_client import GatewayClient
from .graph import build_graph
from .model import make_model
from .scenarios import load_scenario

DB_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/agentcrash")
CHECKPOINT_TABLES = "checkpoints, checkpoint_blobs, checkpoint_writes"


class RunRequest(BaseModel):
    scenario: str


def create_app() -> FastAPI:
    state: dict[str, Any] = {"tasks": {}}

    def config(run_id: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": run_id}, "recursion_limit": 400}

    async def drive(run_id: str, scenario: str, resume: bool) -> None:
        graph = state["graph"]
        init = (
            None
            if resume
            else {
                "run_id": run_id,
                "scenario": scenario,
                "step_no": 0,
                "pending": None,
                "history": [],
                "failed": False,
            }
        )
        await graph.ainvoke(init, config(run_id))

    def spawn(run_id: str, scenario: str, resume: bool) -> None:
        t = asyncio.create_task(drive(run_id, scenario, resume))
        state["tasks"][run_id] = t

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        gw = GatewayClient()
        async with AsyncPostgresSaver.from_conn_string(DB_URL) as saver:
            await saver.setup()
            state["saver"] = saver
            state["gw"] = gw
            state["graph"] = build_graph(gw, make_model(), saver)
            # Resume runs that were in flight when the runtime last stopped.
            try:
                for run in await gw.list_runs():
                    tup = await saver.aget_tuple(config(run["run_id"]))  # type: ignore[arg-type]
                    if tup is not None:
                        spawn(run["run_id"], run["scenario"], resume=True)
            except httpx.HTTPError as e:  # gateway may not be up yet; resume is best effort
                print(f"resume skipped: {e!r}")
            yield
            for t in state["tasks"].values():
                t.cancel()
        await gw.aclose()

    app = FastAPI(lifespan=lifespan)

    @app.post("/runs", status_code=201)
    async def post_run(req: RunRequest) -> dict[str, Any]:
        try:
            load_scenario(req.scenario)
        except (FileNotFoundError, ValueError) as e:
            raise HTTPException(404, f"unknown scenario: {e}") from e
        run = await state["gw"].create_run(req.scenario)
        spawn(run["run_id"], req.scenario, resume=False)
        return {"run_id": run["run_id"], "status": run["status"]}

    @app.get("/runs/{run_id}")
    async def get_run(run_id: str) -> dict[str, Any]:
        out: dict[str, Any] = await state["gw"].get_run(run_id)
        return out

    @app.post("/_reset")
    async def reset() -> dict[str, bool]:
        """Test-only: cancel in-flight runs and clear checkpoints."""
        for t in state["tasks"].values():
            t.cancel()
        await asyncio.gather(*state["tasks"].values(), return_exceptions=True)
        state["tasks"].clear()
        async with state["saver"].conn.cursor() as cur:
            await cur.execute(f"TRUNCATE {CHECKPOINT_TABLES}")
        return {"ok": True}

    @app.get("/health")
    async def health() -> dict[str, bool]:
        return {"ok": True}

    return app
