from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import psycopg

ROOT = Path(__file__).resolve().parents[3]
RUN_DIR = ROOT / ".run"
_VENV_BIN = "Scripts" if sys.platform == "win32" else "bin"
RUNTIME_PY = ROOT / "runtime" / ".venv" / _VENV_BIN / ("python.exe" if sys.platform == "win32" else "python")
PORTS = {"mock": 7101, "gateway": 7102, "runtime": 7103, "auth": 7104}
DB_URL = os.environ.get("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/agentcrash")


def url(name: str, path: str = "") -> str:
    return f"http://127.0.0.1:{PORTS[name]}{path}"


def wait_http(u: str, timeout: float = 30.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            if httpx.get(u, timeout=2).status_code < 500:
                return
        except httpx.TransportError:
            pass
        time.sleep(0.1)
    raise TimeoutError(f"{u} did not come up")


def _spawn(name: str, argv: list[str], env_extra: dict[str, str] | None = None) -> subprocess.Popen[bytes]:
    (RUN_DIR / "logs").mkdir(parents=True, exist_ok=True)
    env = {**os.environ, **(env_extra or {})}
    log = open(RUN_DIR / "logs" / f"{name}.log", "ab")  # noqa: SIM115 (lifetime = process lifetime)
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
    p = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=log, stderr=log, creationflags=flags)
    (RUN_DIR / f"{name}.pid").write_text(str(p.pid))
    return p


def start_mock(env: dict[str, str] | None = None) -> subprocess.Popen[bytes]:
    e = {"MOCK_PORT": str(PORTS["mock"]), "MOCK_DIR": str(RUN_DIR / "mock"), **(env or {})}
    p = _spawn("mock", ["node", "mock-servers/dist/index.js"], e)
    wait_http(url("mock", "/health"))
    return p


def start_gateway(env: dict[str, str] | None = None, wait: bool = True) -> subprocess.Popen[bytes]:
    e = {
        "GATEWAY_PORT": str(PORTS["gateway"]),
        "MCP_URL": url("mock", "/mcp"),
        "DATABASE_URL": DB_URL,
        "TRACES_FILE": str(ROOT / "results" / "traces.jsonl"),
        "CRASH_MARKER": str(RUN_DIR / "crash_marker.json"),
        **(env or {}),
    }
    p = _spawn("gateway", ["node", "gateway/dist/index.js"], e)
    if wait:
        wait_http(url("gateway", "/health"))
    return p


def start_runtime(env: dict[str, str] | None = None) -> subprocess.Popen[bytes]:
    e = {"RUNTIME_PORT": str(PORTS["runtime"]), "GATEWAY_URL": url("gateway"), "DATABASE_URL": DB_URL, **(env or {})}
    p = _spawn("runtime", [str(RUNTIME_PY), "-m", "agentcrash_runtime"], e)
    wait_http(url("runtime", "/health"), timeout=60)
    return p


def stop(p: subprocess.Popen[bytes] | None) -> None:
    if p is not None and p.poll() is None:
        p.kill()
        p.wait(timeout=10)


def reset_db() -> None:
    with psycopg.connect(DB_URL, autocommit=True) as c:
        c.execute("TRUNCATE tool_calls, runs CASCADE")


def reset_mock() -> None:
    httpx.post(url("mock", "/_reset"), timeout=5).raise_for_status()


def kill_pidfiles() -> None:
    for pf in RUN_DIR.glob("*.pid"):
        pid = int(pf.read_text())
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, check=False)
        else:
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
        pf.unlink()