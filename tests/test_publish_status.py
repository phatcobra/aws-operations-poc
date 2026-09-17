"""Offline tests for the sanitized public status contract."""
import sys
import copy
import json
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

    def test_workflow_url_alone_is_not_proof(self):
        result = publish_status.proof_summary(
            None,
            run_url="https://github.com/phatcobra/aws-operations-poc/actions/runs/123",
        )
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["scenarios"], {})

    def test_real_artifact_is_validated_and_sanitized(self):
        result = publish_status.proof_summary(valid_proof())
        self.assertEqual(result["state"], "verified")
        self.assertEqual(result["source"], "evidence_artifact")
        self.assertEqual(result["scenarios"]["permanent"]["attempts"], 3)
        self.assertNotIn("private", json.dumps(result))
        self.assertNotIn("deployment_identity", json.dumps(result))

    def test_missing_invalid_or_failed_proof_is_unknown(self):
        variants = [None, {}, {"result": "fail"}, {"result": "pass", "verified_at": "bad"}]
        for field, value in [("persisted_attempts", []), ("cloudwatch_log_events", 0), ("final_attempt", 4), ("final_status", "success")]:
            proof = valid_proof()
            proof["scenarios"]["permanent"][field] = value
            variants.append(proof)
        proof = valid_proof()
        proof["scenarios"]["normal"]["persisted_attempts"] = [None]
        variants.append(proof)
        for proof in variants:
            with self.subTest(proof=proof):
                self.assertEqual(publish_status.proof_summary(proof)["state"], "unknown")

    def test_proof_links_cannot_leave_the_poc(self):
        for url in ["javascript:alert(1)", "https://example.com", "https://github.com/phatcobra/aws-operations-poc/actions/runs/1?redirect=1"]:
            self.assertEqual(publish_status.proof_summary(valid_proof(), url)["url"], "https://github.com/phatcobra/aws-operations-poc/actions")

    def test_public_history_contains_only_allowlisted_fields(self):
        item = record("private-5", NOW.isoformat(), "scheduled", 1, "success", "not_needed")
        item.update({"error": "secret", "external_request_result": "secret"})
        result = publish_status.summarize_runs([item])[0]
        self.assertEqual(result["attempt_history"], [{"attempt": 1, "status": "success", "recovery_state": "not_needed"}])
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("private", json.dumps(result))

    def test_latest_hourly_is_not_displaced_by_test_burst(self):
        hourly = record("hourly", (NOW - timedelta(hours=1)).isoformat(), "scheduled", 1, "success", "not_needed")
        tests = [record(str(i), (NOW - timedelta(seconds=i)).isoformat(), "cd-live-proof", 1, "success", "not_needed") for i in range(20)]
        result = publish_status.summarize_runs(tests + [hourly])
        self.assertEqual(len(result), 12)
        self.assertEqual(sum(r["trigger"] == "automatic" for r in result), 1)

    def test_future_check_is_not_healthy(self):
        latest = record("future", (NOW + timedelta(hours=1)).isoformat(), "scheduled", 1, "success", "not_needed")
        self.assertEqual(publish_status.schedule_health(latest, NOW)["state"], "unknown")


def valid_proof():
    expected = {
        "normal": [(1, "success", "not_needed")],
        "transient": [(1, "failure", "retrying"), (2, "success", "recovered")],
        "permanent": [(1, "failure", "retrying"), (2, "failure", "retrying"), (3, "failure", "exhausted")],
    }
    proof = {"result": "pass", "verified_at": NOW.isoformat(), "deployment_identity": "private", "scenarios": {}}
    for name, rows in expected.items():
        n, status, recovery = rows[-1]
        proof["scenarios"][name] = {"run_id": "private", "final_attempt": n, "final_status": status, "recovery_state": recovery, "cloudwatch_log_events": 2,
            "persisted_attempts": [{"attempt_number": n, "status": s, "recovery_state": r} for n, s, r in rows]}
    return copy.deepcopy(proof)


if __name__ == "__main__":
    unittest.main()
