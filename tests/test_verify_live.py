"""Offline contract tests for scripts/verify_live.py."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import verify_live  # noqa: E402


def record(run_id, attempt, status, recovery):
    return {
        "run_id": run_id,
        "attempt_number": attempt,
        "status": status,
        "recovery_state": recovery,
    }


class ValidateScenarioTests(unittest.TestCase):
    def test_normal_contract(self):
        final = record("r1", 1, "success", "not_needed")
        verify_live.validate_scenario("normal", final, [final.copy()])

    def test_transient_recovery_contract(self):
        records = [
            record("r2", 1, "failure", "retrying"),
            record("r2", 2, "success", "recovered"),
        ]
        verify_live.validate_scenario("transient", records[-1].copy(), records)

    def test_permanent_exhaustion_contract(self):
        records = [
            record("r3", 1, "failure", "retrying"),
            record("r3", 2, "failure", "retrying"),
            record("r3", 3, "failure", "exhausted"),
        ]
        verify_live.validate_scenario("permanent", records[-1].copy(), records)

    def test_wrong_attempt_history_fails(self):
        records = [record("r4", 1, "success", "not_needed")]
        with self.assertRaises(AssertionError):
            verify_live.validate_scenario("transient", records[-1].copy(), records)


if __name__ == "__main__":
    unittest.main()
