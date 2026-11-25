from __future__ import annotations

import json
import statistics
import subprocess
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from . import supervisor as sup
from .compare import compare
from .scenario import Scenario, load_scenario

POINTS = ["P1_after_planned", "P2_after_exec", "P3_after_commit", "P4_awaiting_approval"]
MARKER = sup.RUN_DIR / "crash_marker.json"


@dataclass
class Row:
    step: int
    point: str
    crashed: bool
    duplicates: int
    lost: int
    unknown: int
    recovery_ms: int
    ok: bool
    duplicate_tools: list[str] = field(default_factory=list)
    end_status: str = ""
    crashes: int = 0

    def as_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["pass"] = d.pop("ok")
        return d


def _git_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=sup.ROOT, capture_output=True, text=True, check=True
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def _effects() -> list[dict[str, Any]]:
    r = httpx.get(sup.url("mock", "/_effects"), timeout=10)
    r.raise_for_status()
    out: list[dict[str, Any]] = r.json()
    return out


def _run(run_id: str) -> dict[str, Any]:
    r = httpx.get(sup.url("gateway", f"/v1/runs/{run_id}"), timeout=10)
    r.raise_for_status()
    out: dict[str, Any] = r.json()
    return out


def _reset() -> None:
    sup.reset_db()
    sup.reset_mock()
    MARKER.unlink(missing_ok=True)
    httpx.post(sup.url("runtime", "/_reset"), timeout=30).raise_for_status()


def _gw_env(unsafe: bool, crash_at: str | None) -> dict[str, str]:
    env: dict[str, str] = {}
    if unsafe:
        env["GATEWAY_MODE"] = "unsafe"
    if crash_at:
        env["CRASH_AT"] = crash_at
    return env


def _start_run(scenario: str) -> str:
    r = httpx.post(sup.url("runtime", "/runs"), json={"scenario": scenario}, timeout=30)
    r.raise_for_status()
    return str(r.json()["run_id"])


def _approve_pending(run_id: str, skip_step: int | None = None) -> None:
    try:
        for c in _run(run_id).get("calls", []):
            if c["state"] == "AWAITING_APPROVAL" and c["step_no"] != skip_step:
                httpx.post(
                    sup.url("gateway", f"/v1/runs/{run_id}/approve"),
                    json={"step_no": c["step_no"]},
                    headers=sup.operator_headers(),
                    timeout=10,
                )
    except httpx.HTTPError:
        pass  # gateway may be mid-crash; the next poll or the settle loop retries


def _settle(
    run_id: str, timeout: float = 60.0, tick: Callable[[], None] | None = None
) -> dict[str, Any]:
    """Act as the operator: approve gated calls; stop at DONE/FAILED or at a stable UNKNOWN."""
    end = time.time() + timeout
    last: dict[str, Any] = {}
    while time.time() < end:
        if tick:
            tick()
        try:
            last = _run(run_id)
        except httpx.HTTPError:
            time.sleep(0.1)
            continue
        calls = last.get("calls", [])
        _approve_pending(run_id)
        if last.get("status") in ("DONE", "FAILED"):
            return last
        if last.get("status") == "WAITING_APPROVAL" and any(c["state"] == "UNKNOWN" for c in calls):
            return last
        time.sleep(0.1)
    raise TimeoutError(f"run {run_id} did not settle: {last}")


def record_oracle(scenario: Scenario, name: str) -> list[dict[str, Any]]:
    """Clean run of the scenario; its effects must equal the scenario's intended effects."""
    _reset()
    gw = sup.start_gateway(_gw_env(False, None))
    try:
        final = _settle(_start_run(name))
        if final["status"] != "DONE":
            raise RuntimeError(f"clean run did not finish: {final}")
        effects = _effects()
    finally:
        sup.stop(gw)
    if not compare(scenario, effects, None).ok:
        raise RuntimeError("clean run does not match the scenario's intended effects")
    return effects


def _wait_death(
    gw: subprocess.Popen[bytes], run_id: str, step: int, point: str, seconds: float
) -> bool:
    """Wait for the gateway to die by its own crash hook. Returns False if it is still alive."""
    deadline = time.time() + seconds
    while gw.poll() is None:
        if time.time() > deadline:
            return False
        # The operator approves gated steps that precede the crash (never the crash step at P4).
        _approve_pending(run_id, step if point == "P4_awaiting_approval" else None)
        time.sleep(0.05)
    if not (MARKER.exists() and json.loads(MARKER.read_text())["point"] == point):
        raise RuntimeError(f"gateway exited without the crash hook at {point}")
    return True


def _wait_up_or_dead(gw: subprocess.Popen[bytes], seconds: float = 15.0) -> None:
    deadline = time.time() + seconds
    while gw.poll() is None and time.time() < deadline:
        try:
            if httpx.get(sup.url("gateway", "/health"), timeout=1).status_code < 500:
                return
        except httpx.TransportError:
            pass
        time.sleep(0.05)


def run_point(
    scenario: Scenario, name: str, step: int, point: str, unsafe: bool, double: bool = False
) -> Row:
    _reset()
    spec = f"{step}:{point}"
    gw = sup.start_gateway(_gw_env(unsafe, spec))
    # Unsafe mode has no approval gate, so P4 never fires there.
    expects_crash = point != "P4_awaiting_approval" or (
        scenario.steps[step].requires_approval and not unsafe
    )
    run_id = _start_run(name)
    crashes = 0
    if expects_crash:
        if not _wait_death(gw, run_id, step, point, 20):
            raise RuntimeError(f"crash hook {spec} never fired")
        crashes = 1
    t0 = time.time()
    if crashes and double:
        # Second kill: the same hook fires again while the restarted gateway recovers the call.
        MARKER.unlink(missing_ok=True)
        gw = sup.start_gateway({**_gw_env(unsafe, spec), "CRASH_ON_RECOVERY": "1"}, wait=False)
        _wait_up_or_dead(gw)
        if _wait_death(gw, run_id, step, point, 8):
            crashes = 2
    if crashes and gw.poll() is not None:
        gw = sup.start_gateway(_gw_env(unsafe, None))

    def tick() -> None:
        nonlocal gw, crashes
        if gw.poll() is not None:  # an armed gateway died during recovery: restart clean
            crashes += 1
            gw = sup.start_gateway(_gw_env(unsafe, None))

    try:
        final = _settle(run_id, tick=tick)
        recovery_ms = int((time.time() - t0) * 1000)
        unknown = [c["step_no"] for c in final.get("calls", []) if c["state"] == "UNKNOWN"]
        cmp = compare(scenario, _effects(), unknown[0] if unknown else None)
    finally:
        sup.stop(gw)
    return Row(
        step=step,
        point=point,
        crashed=crashes > 0,
        duplicates=cmp.duplicates,
        lost=cmp.lost,
        unknown=len(unknown),
        recovery_ms=recovery_ms if crashes else 0,
        ok=cmp.ok,
        duplicate_tools=cmp.duplicate_tools,
        end_status=str(final.get("status")),
        crashes=crashes,
    )


def _p95(xs: list[int]) -> int:
    if not xs:
        return 0
    s = sorted(xs)
    return s[max(0, -(-95 * len(s) // 100) - 1)]


def sweep(
    name: str,
    unsafe: bool,
    out_dir: Path,
    only: list[tuple[int, str]] | None = None,
    double: bool = False,
) -> tuple[Path, dict[str, Any]]:
    scenario = load_scenario(name)
    started = datetime.now(UTC)
    sup.kill_pidfiles()
    mock = sup.start_mock()
    auth = sup.start_auth() if sup.AUTH else None
    boot_gw = sup.start_gateway()  # the runtime lists runs from the gateway at start-up
    runtime = sup.start_runtime()
    sup.stop(boot_gw)
    rows: list[Row] = []
    try:
        record_oracle(scenario, name)
        for step in range(len(scenario.steps)):
            for point in POINTS:
                if only is not None and (step, point) not in only:
                    continue
                row = run_point(scenario, name, step, point, unsafe, double)
                print(
                    f"step {step} {point}: dup={row.duplicates} lost={row.lost} "
                    f"unknown={row.unknown} {'ok' if row.ok else 'FAIL'}",
                    flush=True,
                )
                rows.append(row)
    finally:
        sup.stop(runtime)
        sup.stop(mock)
        sup.stop(auth)
        sup.kill_pidfiles()
    rec = [r.recovery_ms for r in rows if r.crashed]
    summary = {
        "points": len(rows),
        "duplicates": sum(r.duplicates for r in rows),
        "lost": sum(r.lost for r in rows),
        "unknown": sum(r.unknown for r in rows),
        "max_recovery_ms": max(rec, default=0),
        "p50_recovery_ms": int(statistics.median(rec)) if rec else 0,
        "p95_recovery_ms": _p95(rec),
        "failed_points": [[r.step, r.point] for r in rows if not r.ok],
    }
    report = {
        "scenario": name,
        "mode": "unsafe" if unsafe else ("double" if double else "safe"),
        "git_sha": _git_sha(),
        "started": started.isoformat(),
        "rows": [r.as_json() for r in rows],
        "summary": summary,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    tag = "_unsafe" if unsafe else ("_double" if double else "")
    path = out_dir / f"sweep_{name}{tag}_{started.strftime('%Y%m%dT%H%M%SZ')}.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return path, report

