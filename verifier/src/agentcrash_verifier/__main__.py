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
    sw.add_argument("--double", action="store_true", help="kill again during recovery")
    sw.add_argument("--out", default=str(sup.ROOT / "results"))
    fz = sub.add_parser("fuzz")
    fz.add_argument("--n", type=int, default=500)
    fz.add_argument("--seed", type=int, default=None)
    fz.add_argument("--replay", default=None, help="replay a file from verifier/regressions")
    fz.add_argument("--out", default=str(sup.ROOT / "results"))
    ld = sub.add_parser("load")
    ld.add_argument("--runs", type=int, default=50)
    ld.add_argument("--kills", type=int, default=5)
    ld.add_argument("--seed", type=int, default=7)
    ld.add_argument("--out", default=str(sup.ROOT / "results"))
    bn = sub.add_parser("bench")
    bn.add_argument("label", choices=["before", "after", "merge"])
    bn.add_argument("--calls", type=int, default=1000)
    bn.add_argument("--out", default=str(sup.ROOT / "results"))
    args = ap.parse_args(argv)
    if args.cmd == "bench":
        from .bench import merge, run_label

        if args.label == "merge":
            path, res = merge(Path(args.out))
        else:
            path, res = run_label(args.label, args.calls, Path(args.out))
        print(f"report: {path}")
        print(json.dumps(res, indent=2))
        return 0
    if args.cmd == "load":
        from .load import load

        path, report = load(args.runs, args.kills, Path(args.out), args.seed)
        print(f"report: {path}")
        print(json.dumps(report, indent=2))
        ok = report["duplicates"] == 0 and report["lost"] == 0 and report["kills"] == args.kills
        return 0 if ok else 1
    if args.cmd == "fuzz":
        from .fuzz import fuzz, replay

        if args.replay:
            return 0 if replay(Path(args.replay)) else 1
        path, report = fuzz(args.n, args.seed, Path(args.out))
        print(f"report: {path}")
        print(json.dumps(report, indent=2))
        return 0 if report["failures"] == 0 else 1
    if args.cmd == "sweep":
        from .sweep import sweep

        path, report = sweep(args.scenario, args.unsafe, Path(args.out), double=args.double)
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
