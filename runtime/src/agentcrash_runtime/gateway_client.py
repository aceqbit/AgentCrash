from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import httpx


class ToolRejected(Exception):
    """The gateway reports the call as FAILED (rejected by an operator)."""


class GatewayClient:
    def __init__(self, base_url: str | None = None) -> None:
        self.base = (base_url or os.environ.get("GATEWAY_URL", "http://127.0.0.1:7102")).rstrip("/")
        self.http = httpx.AsyncClient(timeout=30)
        self._token: tuple[str, float] | None = None

    async def aclose(self) -> None:
        await self.http.aclose()

    async def _headers(self) -> dict[str, str]:
        url = os.environ.get("AUTH_TOKEN_URL")
        if not url:
            return {}
        if self._token is None or self._token[1] < time.time() + 30:
            r = await self.http.post(
                url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": os.environ["AUTH_CLIENT_ID"],
                    "client_secret": os.environ["AUTH_CLIENT_SECRET"],
                },
            )
            r.raise_for_status()
            body = r.json()
            self._token = (body["access_token"], time.time() + float(body["expires_in"]))
        return {"Authorization": f"Bearer {self._token[0]}"}

    async def create_run(self, scenario: str, run_id: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"scenario": scenario}
        if run_id:
            body["run_id"] = run_id
        r = await self.http.post(f"{self.base}/v1/runs", json=body)
        r.raise_for_status()
        out: dict[str, Any] = r.json()
        return out

    async def get_run(self, run_id: str) -> dict[str, Any]:
        r = await self.http.get(f"{self.base}/v1/runs/{run_id}")
        r.raise_for_status()
        out: dict[str, Any] = r.json()
        return out

    async def list_runs(self, statuses: str = "RUNNING,WAITING_APPROVAL") -> list[dict[str, Any]]:
        r = await self.http.get(f"{self.base}/v1/runs", params={"status": statuses})
        r.raise_for_status()
        out: list[dict[str, Any]] = r.json()
        return out

    async def finish_run(self, run_id: str, status: str = "DONE") -> None:
        for _ in range(600):
            try:
                r = await self.http.post(
                    f"{self.base}/v1/runs/{run_id}/finish", json={"status": status}
                )
                if r.status_code < 500:
                    r.raise_for_status()
                    return
            except httpx.TransportError:
                pass
            await asyncio.sleep(0.2)
        raise RuntimeError("gateway unreachable while finishing run")

    async def call_tool(
        self, run_id: str, step_no: int, call: dict[str, Any], poll: float = 0.25
    ) -> Any:
        """Call a tool through the gateway, retrying across gateway restarts.

        The same (run, step, tool, args) always yields the same journaled outcome, so retrying is safe.
        """
        url = f"{self.base}/v1/runs/{run_id}/steps/{step_no}/call"
        delay = 0.1
        while True:
            try:
                r = await self.http.post(url, json=call, headers=await self._headers())
            except httpx.TransportError:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 1.0)
                continue
            if r.status_code == 200:
                return r.json()["result"]
            if r.status_code == 202:  # AWAITING_APPROVAL or UNKNOWN: wait for an operator
                await asyncio.sleep(poll)
                continue
            if r.status_code == 410:
                raise ToolRejected(r.text)
            if r.status_code >= 500:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 1.0)
                continue
            r.raise_for_status()
