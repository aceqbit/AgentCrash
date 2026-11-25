"""E5: the unsafe gateway must produce duplicates; the safe gateway must not (subset of points)."""

import os
from pathlib import Path

import pytest

from agentcrash_verifier.sweep import sweep

pytestmark = pytest.mark.skipif(os.environ.get("INTEGRATION") != "1", reason="needs INTEGRATION=1")

POINTS = [(0, "P2_after_exec"), (2, "P3_after_commit")]


def test_safe_sweep_finds_no_duplicates(tmp_path: Path) -> None:
    _, report = sweep("bank_5", False, tmp_path, only=POINTS)
    assert report["summary"]["points"] == 2
    assert report["summary"]["duplicates"] == 0
    assert report["summary"]["lost"] == 0


def test_unsafe_sweep_finds_duplicates(tmp_path: Path) -> None:
    _, report = sweep("bank_5", True, tmp_path, only=POINTS)
    assert report["summary"]["duplicates"] >= 1
    assert report["summary"]["failed_points"]
