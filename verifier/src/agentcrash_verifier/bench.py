from __future__ import annotations

import json
import math
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from . import supervisor as sup
from .sweep import _git_sha

WARMUP = 50


def _pct(xs: list[float], p: float) -> float:
    s = sorted(xs)
    return round(s[max(0, math.ceil(p / 100 * len(s)) - 1)], 3)


def _measure(mode: str, calls: int) -> list[float]:
    gw = sup.start_gateway({"GATEWAY_MODE": mode, "TRACES_FILE": str(sup.RUN_DIR / "bench-traces.jsonl")})
    try:
        run_id = str(uuid.uuid4())
        with httpx.Client(timeout=30) as c:
            c.post(sup.url("gateway", "/v1/runs"), json={"scenario": "bench", "run_id": run_id}).raise_for_status()
            lat: list[float] = []
            for i in range(WARMUP + calls):
                body = {"tool": "get_balance", "args": {"account": f"acct-{i}"}}
                t0 = time.perf_counter()
                r = c.post(sup.url("gateway", f"/v1/runs/{run_id}/steps/{i}/call"), json=body)
                dt = (time.perf_counter() - t0) * 1000
                r.raise_for_status()
                if i >= WARMUP:
                    lat.append(dt)
        return lat
    finally:
        sup.stop(gw)


def run_label(label: str, calls: int, out_dir: Path) -> tuple[Path, dict[str, Any]]:
    sup.kill_pidfiles()
    mock = sup.start_mock()
    try:
        _reset_db_only()
        passthrough = _measure("passthrough", calls)
        _reset_db_only()
        journal = _measure("safe", calls)
    finally:
        sup.stop(mock)
        sup.kill_pidfiles()
    res: dict[str, Any] = {
        "git_sha": _git_sha(),
        "label": label,
        "calls": calls,
        "journal_p50_ms": _pct(journal, 50),
        "journal_p95_ms": _pct(journal, 95),
        "passthrough_p50_ms": _pct(passthrough, 50),
        "passthrough_p95_ms": _pct(passthrough, 95),
    }
    res["overhead_p50_ms"] = round(res["journal_p50_ms"] - res["passthrough_p50_ms"], 3)
    res["overhead_p95_ms"] = round(res["journal_p95_ms"] - res["passthrough_p95_ms"], 3)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"benchrun_{label}_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.json"
    path.write_text(json.dumps(res, indent=2), encoding="utf-8")
    return path, res


def _reset_db_only() -> None:
    sup.reset_db()
    sup.reset_mock()


def merge(out_dir: Path) -> tuple[Path, dict[str, Any]]:
    def latest(label: str) -> dict[str, Any]:
        files = sorted(out_dir.glob(f"benchrun_{label}_*.json"))
        if not files:
            raise SystemExit(f"no benchrun_{label}_*.json; run bench {label} first")
        out: dict[str, Any] = json.loads(files[-1].read_text(encoding="utf-8"))
        return out

    sweeps = sorted(f for f in out_dir.glob("sweep_*.json") if "_unsafe_" not in f.name and "_double_" not in f.name)
    rec: dict[str, Any] = {}
    if sweeps:
        s = json.loads(sweeps[-1].read_text(encoding="utf-8"))["summary"]
        rec = {
            "source": sweeps[-1].name,
            "p50_ms": s["p50_recovery_ms"],
            "p95_ms": s["p95_recovery_ms"],
            "max_ms": s["max_recovery_ms"],
        }
    before, after = latest("before"), latest("after")
    res = {
        "git_sha": _git_sha(),
        "calls": after["calls"],
        "before": before,
        "after": after,
        "recovery": rec,
    }
    path = out_dir / f"bench_{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.json"
    path.write_text(json.dumps(res, indent=2), encoding="utf-8")
    return path, res
