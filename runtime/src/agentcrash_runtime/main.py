import asyncio
import os

import uvicorn

from .app import create_app


def main() -> None:
    cfg = uvicorn.Config(
        create_app(),
        host="127.0.0.1",
        port=int(os.environ.get("RUNTIME_PORT", "7103")),
        log_level="warning",
    )
    asyncio.run(uvicorn.Server(cfg).serve())


if __name__ == "__main__":
    main()
