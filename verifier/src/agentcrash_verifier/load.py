from __future__ import annotations

import json
import math
import os
import random
import threading
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from . import supervisor as sup
from .scenario import idempotency_key, load_scenario
from .sweep import _git_sha

TRACES = sup.RUN_DIR / "load-traces.jsonl"


def _pct(xs: list[float], p: float) -> int:
    if not xs:
        return 0
    s = sorted(xs)
    return int(s[max(0, math.ceil(p / 100 * len(s)) - 1)])


def _gw() -> Any:
    return sup.start_gateway({"TRACES_FILE": str(TRACES)})


def _operator_step(run_id: str, run: dict[str, Any]) -> None:
    """Approve only the AWAITING_APPROVAL calls; UNKNOWN calls stay surfaced for a human."""
    for c in run.get("calls", []):
        if c["state"] == "AWAITING_APPROVAL":
            httpx.post(
                sup.url("gateway", f"/v1/runs/{run_id}/approve"),
                json={"step_no": c["step_no"]},
                headers=sup.operator_headers(),
                timeout=10,
            )


def _settled(run: dict[str, Any]) -> bool:
    if run["status"] in ("DONE", "FAILED"):
        return True
    return run["status"] == "WAITING_APPROVAL" and any(
        c["state"] == "UNKNOWN" for c in run.get("calls", [])
    )


def load(runs: int, kills: int, out_dir: Path, seed: int, scenario_name: str = "bank_5") -> tuple[Path, dict[str, Any]]:
    rnd = random.Random(seed)
    print(f"load seed: {seed}", flush=True)
    scenario = load_scenario(scenario_name)
    started = datetime.now(UTC)
    TRACES.unlink(missing_ok=True)
    sup.kill_pidfiles()
    mock = sup.start_mock({"MOCK_DELAY_MS": os.environ.get("MOCK_DELAY_MS", "3000")})
    auth = sup.start_auth() if sup.AUTH else None
    sup.reset_db()
    sup.reset_mock()
    boot = sup.start_gateway()
    runtime = sup.start_runtime()
    sup.stop(boot)
    httpx.post(sup.url("runtime", "/_reset"), timeout=30).raise_for_status()
    gw = _gw()
    ids = [
        str(httpx.post(sup.url("runtime", "/runs"), json={"scenario": scenario_name}, timeout=30).json()["run_id"])
        for _ in range(runs)
    ]
    holder: dict[str, Any] = {"gw": gw, "kills": 0}
    final: dict[str, dict[str, Any]] = {}
    stop_killer = threading.Event()

    def killer() -> None:
        time.sleep(0.3)
        while holder["kills"] < kills and not stop_killer.is_set():
            sup.stop(holder["gw"])  # hard kill at an arbitrary moment, not at a hook
            time.sleep(rnd.uniform(0.0, 0.3))
            holder["gw"] = _gw()
            holder["kills"] += 1
            stop_killer.wait(rnd.uniform(0.3, 0.9))

    kt = threading.Thread(target=killer, daemon=True)
    kt.start()
    try:
        deadline = time.time() + 300
        while len(final) < runs:
            if time.time() > deadline:
                raise TimeoutError(f"only {len(final)}/{runs} runs settled")
            for rid in ids:
                if rid in final:
                    continue
                try:
                    run = httpx.get(sup.url("gateway", f"/v1/runs/{rid}"), timeout=10).json()
                    _operator_step(rid, run)
                except (httpx.HTTPError, ValueError):
                    continue  # gateway is down or restarting; poll again
                if _settled(run):
                    final[rid] = run
            time.sleep(0.1)
        stop_killer.set()
        kt.join(timeout=30)
        done_kills = int(holder["kills"])
        gw = holder["gw"]
        # Let any in-flight resend finish before reading the ground truth.
        time.sleep(1.0)
        effects: list[dict[str, Any]] = httpx.get(sup.url("mock", "/_effects"), timeout=30).json()
    finally:
        stop_killer.set()
        kt.join(timeout=30)
        sup.stop(holder["gw"])
        sup.stop(runtime)
        sup.stop(mock)
        sup.stop(auth)
        sup.kill_pidfiles()

    by_key = Counter(e["key"] for e in effects)
    dups = lost = unknown = 0
    expected_keys: set[str] = set()
    for rid in ids:
        unknown_steps = {c["step_no"] for c in final[rid].get("calls", []) if c["state"] == "UNKNOWN"}
        first_unknown = min(unknown_steps) if unknown_steps else None
        for i, step in enumerate(scenario.steps):
            if first_unknown is not None and i > first_unknown:
                continue
            k = idempotency_key(rid, i, step.tool, step.args)
            expected_keys.add(k)
            n = by_key[k]
            if i == first_unknown:
                dups += max(0, n - 1)
            else:
                dups += max(0, n - 1)
                lost += 1 if n == 0 else 0
        unknown += len(unknown_steps)
    stray = sum(n for k, n in by_key.items() if k not in expected_keys)
    scans = _recovery_scans()
    report = {
        "git_sha": _git_sha(),
        "started": started.isoformat(),
        "seed": seed,
        "scenario": scenario_name,
        "runs": runs,
        "completed": sum(1 for r in final.values() if r["status"] == "DONE"),
        "waiting_unknown": sum(1 for r in final.values() if r["status"] == "WAITING_APPROVAL"),
        "kills": done_kills,
        "duplicates": dups + stray,
        "lost": lost,
        "unknown": unknown,
        "stray_effects": stray,
        "recovery_scans": len(scans),
        "recovery_p50_ms": _pct(scans, 50),
        "recovery_p95_ms": _pct(scans, 95),
        "recovery_max_ms": _pct(scans, 100),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"load_{started.strftime('%Y%m%dT%H%M%SZ')}.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return path, report


def _recovery_scans() -> list[float]:
    if not TRACES.exists():
        return []
    out: list[float] = []
    for line in TRACES.read_text(encoding="utf-8").splitlines():
        if '"recovery.scan"' in line:
            out.append(float(json.loads(line)["duration_ms"]))
    return out
