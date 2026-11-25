"""Needs the stack (`just up`). Skipped unless INTEGRATION=1."""

import os
import time

import httpx
import pytest

pytestmark = pytest.mark.skipif(os.environ.get("INTEGRATION") != "1", reason="integration")

RUNTIME = "http://127.0.0.1:7103"
MOCK = "http://127.0.0.1:7101"


def _wait_done(run_id: str, timeout: float = 60) -> dict:  # type: ignore[type-arg]
    end = time.time() + timeout
    while time.time() < end:
        run = httpx.get(f"{RUNTIME}/runs/{run_id}").json()
        if run["status"] == "WAITING_APPROVAL":
            httpx.post(f"http://127.0.0.1:7102/v1/runs/{run_id}/approve", json={})
        if run["status"] in ("DONE", "FAILED"):
            return run  # type: ignore[no-any-return]
        time.sleep(0.2)
    raise TimeoutError(run)


def test_bank_5_completes_without_crashes() -> None:
    httpx.post(f"{MOCK}/_reset")
    run_id = httpx.post(f"{RUNTIME}/runs", json={"scenario": "bank_5"}).json()["run_id"]
    run = _wait_done(run_id)
    assert run["status"] == "DONE"
    assert len(run["calls"]) == 5
    assert all(c["state"] == "DONE" for c in run["calls"])
    effects = httpx.get(f"{MOCK}/_effects").json()
    assert [e["tool"] for e in effects] == [
        "transfer",
        "create_ticket",
        "send_email",
        "transfer",
        "send_email",
    ]
