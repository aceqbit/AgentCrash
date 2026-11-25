from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import supervisor as sup


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="agentcrash_verifier")
    sub = ap.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("stack")
    st.add_argument("action", choices=["up", "down"])
    sw = sub.add_parser("sweep")
    sw.add_argument("--scenario", default="bank_5")
    sw.add_argument("--unsafe", action="store_true")
    sw.add_argument("--out", default=str(sup.ROOT / "results"))
    args = ap.parse_args(argv)
    if args.cmd == "sweep":
        from .sweep import sweep

        path, report = sweep(args.scenario, args.unsafe, Path(args.out))
        print(f"report: {path}")
        print(json.dumps(report["summary"], indent=2))
        # CI gate: any duplicate or lost effect fails (E1, E2, E3).
        return 0 if all(r["pass"] for r in report["rows"]) else 1
    if args.action == "up":
        sup.kill_pidfiles()
        sup.start_mock()
        if sup.AUTH:
            sup.start_auth()
        sup.start_gateway()
        sup.start_runtime()
        print("stack up: mock 7101, gateway 7102, runtime 7103")
    else:
        sup.kill_pidfiles()
        print("stack down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
