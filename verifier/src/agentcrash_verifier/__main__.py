from __future__ import annotations

import argparse
import sys

from . import supervisor as sup


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="agentcrash_verifier")
    sub = ap.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("stack")
    st.add_argument("action", choices=["up", "down"])
    args = ap.parse_args(argv)
    if args.cmd == "stack":
        if args.action == "up":
            sup.kill_pidfiles()
            sup.start_mock()
            sup.start_gateway()
            sup.start_runtime()
            print("stack up: mock 7101, gateway 7102, runtime 7103")
        else:
            sup.kill_pidfiles()
            print("stack down")
    return 0


if __name__ == "__main__":
    sys.exit(main())