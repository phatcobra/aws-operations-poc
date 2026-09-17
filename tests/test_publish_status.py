"""Offline tests for the sanitized public status contract."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import publish_status  # noqa: E402


NOW = datetime(2026, 9, 17, 18, 0, tzinfo=timezone.utc)


def record(run_id, timestamp, trigger, attempt, status, recovery, event=None):
    return {
        "run_id": run_id,
        "timestamp": timestamp,
        "trigger_type": trigger,
        "event": event or ("run_success" if status == "success" else "run_attempt_failed"),
        "status": status,
        "recovery_state": recovery,
        "attempt_number": attempt,
        "latency_ms": 12.3,
    }


class PublicSummaryTests(unittest.TestCase):
    def test_groups_attempts_without_exposing_run_id(self):
        records = [
            record("private-1", "2026-09-17T17:59:00+00:00", "scheduled", 1, "failure", "retrying"),
            record("private-1", "2026-09-17T17:59:01+00:00", "scheduled", 2, "success", "recovered"),
        ]
        result = publish_status.summarize_runs(records)
        self.assertEqual(result[0]["result"], "recovered")
        self.assertEqual(result[0]["attempts"], 2)
        self.assertNotIn("run_id", result[0])

    def test_permanent_failure_is_publicly_safe_shutdown(self):
        records = [
            record("private-2", "2026-09-17T17:50:00+00:00", "cd-live-proof", 1, "failure", "retrying"),
            record("private-2", "2026-09-17T17:50:01+00:00", "cd-live-proof", 2, "failure", "retrying"),
            record("private-2", "2026-09-17T17:50:02+00:00", "cd-live-proof", 3, "failure", "exhausted"),
        ]
        result = publish_status.summarize_runs(records)
        self.assertEqual(result[0]["result"], "exhausted")
        self.assertEqual(result[0]["attempts"], 3)

    def test_stale_schedule_is_not_reported_healthy(self):
        latest = record(
            "private-3",
            (NOW - timedelta(hours=3)).isoformat(),
            "scheduled",
            1,
            "success",
            "not_needed",
        )
        result = publish_status.schedule_health(latest, now=NOW)
        self.assertEqual(result["state"], "stale")

    def test_recent_success_is_healthy_when_schedule_is_ok(self):
        latest = record(
            "private-4",
            (NOW - timedelta(minutes=12)).isoformat(),
            "scheduled",
            1,
            "success",
            "not_needed",
        )
        heartbeat = publish_status.schedule_health(latest, now=NOW)
        result = publish_status.build_snapshot([latest], heartbeat, now=NOW)
        self.assertEqual(result["status"], "healthy")
        self.assertEqual(result["checks"][0]["state"], "pass")

    def test_missing_source_fails_closed_to_unknown(self):
        result = publish_status.build_snapshot(
            [],
            {"state": "unknown", "message": "No source"},
            now=NOW,
        )
        self.assertEqual(result["status"], "unknown")
        self.assertNotEqual(result["status"], "healthy")

    def test_successful_cd_without_raw_proof_gets_contract_labels(self):
        result = publish_status.proof_summary(
            None,
            run_url="https://github.com/phatcobra/aws-operations-poc/actions/runs/123",
        )
        self.assertEqual(result["state"], "verified")
        self.assertEqual(result["scenarios"]["transient"]["result"], "recovered")
        self.assertEqual(result["scenarios"]["permanent"]["attempts"], 3)


if __name__ == "__main__":
    unittest.main()
