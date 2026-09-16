#!/usr/bin/env python3
"""End-to-end live proof for the deployed aws-operations-poc workload.

Invokes the Lambda in three deterministic scenarios, verifies the exact
DynamoDB attempt history, confirms matching CloudWatch log events arrive, and
writes a machine-readable evidence artifact. Uses ambient AWS credentials
(GitHub OIDC in CD); it never handles or prints credential material.
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
from boto3.dynamodb.types import TypeDeserializer

FUNCTION_NAME = "aws-operations-poc-worker"
TABLE_NAME = "aws-operations-poc-runs"
LOG_GROUP_NAME = "/aws/lambda/aws-operations-poc-worker"
REGION = "us-east-2"

EXPECTED = {
    "normal": [(1, "success", "not_needed")],
    "transient": [(1, "failure", "retrying"), (2, "success", "recovered")],
    "permanent": [
        (1, "failure", "retrying"),
        (2, "failure", "retrying"),
        (3, "failure", "exhausted"),
    ],
}

_DESERIALIZER = TypeDeserializer()


def _deserialize_item(item: dict[str, Any]) -> dict[str, Any]:
    return {key: _DESERIALIZER.deserialize(value) for key, value in item.items()}


def validate_scenario(label: str, final: dict[str, Any], records: list[dict[str, Any]]) -> None:
    """Raise AssertionError unless final response and persisted attempts match contract."""
    expected = EXPECTED[label]
    ordered = sorted(records, key=lambda row: int(row["attempt_number"]))
    actual = [
        (int(row["attempt_number"]), row["status"], row["recovery_state"])
        for row in ordered
    ]
    assert actual == expected, f"{label}: persisted attempts {actual!r} != {expected!r}"
    assert final["run_id"] == ordered[0]["run_id"], f"{label}: run_id mismatch"
    assert int(final["attempt_number"]) == expected[-1][0], f"{label}: final attempt mismatch"
    assert final["status"] == expected[-1][1], f"{label}: final status mismatch"
    assert final["recovery_state"] == expected[-1][2], f"{label}: final recovery state mismatch"


def _invoke(lambda_client: Any, payload: dict[str, Any]) -> dict[str, Any]:
    response = lambda_client.invoke(
        FunctionName=FUNCTION_NAME,
        InvocationType="RequestResponse",
        Payload=json.dumps(payload).encode("utf-8"),
    )
    if response.get("StatusCode") != 200:
        raise RuntimeError(f"Lambda invoke returned HTTP {response.get('StatusCode')}")
    if response.get("FunctionError"):
        raise RuntimeError(f"Lambda function error: {response['FunctionError']}")
    body = response["Payload"].read()
    result = json.loads(body)
    if not isinstance(result, dict) or "run_id" not in result:
        raise RuntimeError(f"Unexpected Lambda response: {result!r}")
    return result


def _query_records(ddb_client: Any, run_id: str) -> list[dict[str, Any]]:
    response = ddb_client.query(
        TableName=TABLE_NAME,
        KeyConditionExpression="run_id = :rid",
        ExpressionAttributeValues={":rid": {"S": run_id}},
        ConsistentRead=True,
    )
    return [_deserialize_item(item) for item in response.get("Items", [])]


def _wait_for_logs(logs_client: Any, run_id: str, start_ms: int, wait_seconds: int) -> list[dict[str, Any]]:
    deadline = time.monotonic() + wait_seconds
    pattern = f'"{run_id}"'
    while True:
        response = logs_client.filter_log_events(
            logGroupName=LOG_GROUP_NAME,
            startTime=start_ms,
            filterPattern=pattern,
        )
        events = [event for event in response.get("events", []) if run_id in event.get("message", "")]
        if events:
            return events
        if time.monotonic() >= deadline:
            raise AssertionError(f"No CloudWatch log event containing run_id={run_id} within {wait_seconds}s")
        time.sleep(2)


def run_live_proof(log_wait_seconds: int = 45) -> dict[str, Any]:
    session = boto3.Session(region_name=REGION)
    lambda_client = session.client("lambda")
    ddb_client = session.client("dynamodb")
    logs_client = session.client("logs")
    sts_client = session.client("sts")

    scenarios = {
        "normal": {"trigger_type": "cd-live-proof"},
        "transient": {"trigger_type": "cd-live-proof", "fault_injection": "transient"},
        "permanent": {"trigger_type": "cd-live-proof", "fault_injection": "permanent"},
    }

    started_ms = int(time.time() * 1000) - 5000
    proof: dict[str, Any] = {
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "region": REGION,
        "deployment_identity": sts_client.get_caller_identity()["Arn"],
        "function": FUNCTION_NAME,
        "table": TABLE_NAME,
        "log_group": LOG_GROUP_NAME,
        "scenarios": {},
    }

    for label, payload in scenarios.items():
        final = _invoke(lambda_client, payload)
        records = _query_records(ddb_client, final["run_id"])
        validate_scenario(label, final, records)
        log_events = _wait_for_logs(logs_client, final["run_id"], started_ms, log_wait_seconds)
        proof["scenarios"][label] = {
            "run_id": final["run_id"],
            "final_status": final["status"],
            "final_attempt": int(final["attempt_number"]),
            "recovery_state": final["recovery_state"],
            "persisted_attempts": [
                {
                    "attempt_number": int(row["attempt_number"]),
                    "status": row["status"],
                    "recovery_state": row["recovery_state"],
                    "timestamp": row["timestamp"],
                    "latency_ms": str(row["latency_ms"]),
                }
                for row in sorted(records, key=lambda row: int(row["attempt_number"]))
            ],
            "cloudwatch_log_events": len(log_events),
        }

    return proof


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="live-evidence.json")
    parser.add_argument("--log-wait-seconds", type=int, default=45)
    args = parser.parse_args()

    output_path = Path(args.output)
    try:
        proof = run_live_proof(args.log_wait_seconds)
        proof["result"] = "pass"
    except Exception as exc:
        proof = {
            "verified_at": datetime.now(timezone.utc).isoformat(),
            "region": REGION,
            "result": "fail",
            "error_type": type(exc).__name__,
            "error": str(exc),
        }
        output_path.write_text(json.dumps(proof, indent=2, default=str) + "\n", encoding="utf-8")
        print(json.dumps(proof, indent=2, default=str))
        raise

    output_path.write_text(json.dumps(proof, indent=2, default=str) + "\n", encoding="utf-8")
    print(json.dumps(proof, indent=2, default=str))
    print(f"LIVE_PROOF_PASS: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
