from agentcrash_verifier.compare import compare
from agentcrash_verifier.scenario import Scenario, Step


def scen() -> Scenario:
    return Scenario(
        name="t",
        seed=1,
        steps=[
            Step("transfer", {"from": "A", "to": "B", "amount": 10}, True, None, False),
            Step("send_email", {"to": "x", "subject": "s"}, False, None, False),
            Step("transfer", {"from": "B", "to": "C", "amount": 5}, True, None, False),
        ],
    )


def eff(tool: str, args: dict[str, object]) -> dict[str, object]:
    return {"tool": tool, "args": args}


T1 = eff("transfer", {"from": "A", "to": "B", "amount": 10})
E1 = eff("send_email", {"to": "x", "subject": "s"})
T2 = eff("transfer", {"to": "C", "from": "B", "amount": 5})  # key order must not matter


def test_clean_log_passes() -> None:
    r = compare(scen(), [T1, E1, T2], unknown_step=None)
    assert (r.duplicates, r.lost, r.ok) == (0, 0, True)


def test_duplicate_detected() -> None:
    r = compare(scen(), [T1, T1, E1, T2], unknown_step=None)
    assert r.duplicates == 1 and r.lost == 0 and not r.ok
    assert r.duplicate_tools == ["transfer"]


def test_lost_detected() -> None:
    r = compare(scen(), [T1, E1], unknown_step=None)
    assert r.lost == 1 and r.duplicates == 0 and not r.ok


def test_unknown_step_effect_optional_and_later_steps_not_required() -> None:
    # Uncertain send_email (step 1): it may or may not have happened; step 2 is not reached.
    assert compare(scen(), [T1, E1], unknown_step=1).ok
    assert compare(scen(), [T1], unknown_step=1).ok


def test_unknown_step_resent_is_duplicate() -> None:
    r = compare(scen(), [T1, E1, E1], unknown_step=1)
    assert r.duplicates == 1 and not r.ok


def test_unexpected_effect_counts_as_duplicate() -> None:
    r = compare(scen(), [T1, E1, T2, eff("create_ticket", {"title": "z"})], unknown_step=None)
    assert r.duplicates == 1
