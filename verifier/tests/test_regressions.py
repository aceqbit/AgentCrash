"""Replay every saved fuzz regression: each must pass on the current code."""

import os
from pathlib import Path

import pytest

from agentcrash_verifier.fuzz import replay

FILES = sorted((Path(__file__).resolve().parents[1] / "regressions").glob("*.yaml"))

pytestmark = pytest.mark.skipif(os.environ.get("INTEGRATION") != "1", reason="needs INTEGRATION=1")


@pytest.mark.parametrize("path", FILES, ids=[f.name for f in FILES])
def test_regression_passes(path: Path) -> None:
    assert replay(path)
