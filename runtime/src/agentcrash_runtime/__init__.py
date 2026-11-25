import asyncio
import sys

# psycopg's async mode needs a selector event loop; Windows defaults to the proactor loop.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
