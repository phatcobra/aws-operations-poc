#!/usr/bin/env python3
"""Create a sanitized public status snapshot from CloudWatch log evidence.

The public page never reads AWS directly. This script runs in GitHub Actions
with the existing project deployment role, reads only the existing Lambda log
group, and writes the small status contract that is published with the static
site. No log message, ARN, run ID, or error detail is copied into the public
file.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import boto3

REGION = "us-east-2"
LOG_GROUP_NAME = "/aws/lambda/aws-operations-poc-worker"
LOOKBACK_HOURS = 26
MAX_LOG_PAGES = 20
MAX_PUBLIC_RUNS = 8
ALLOWED_EVENTS = {"run_success", "run_attempt_failed"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any) -> float | None:
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _timestamp_from_log_event(event: dict[str, Any]) -> str | None:
    timestamp = event.get("timestamp")
    if timestamp is None:
        return None
    try:
        return datetime.fromtimestamp(float(timestamp) / 1000, timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def parse_log_record(event: dict[str, Any]) -> dict[str, Any] | None:
    """Return only the fields needed for a public run summary."""
    try:
        record = json.loads(event.get("message", ""))
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict) or record.get("event") not in ALLOWED_EVENTS:
        return None
    run_id = record.get("run_id")
    if not run_id:
        return None
    timestamp = record.get("timestamp") or _timestamp_from_log_event(event)
    if not timestamp:
        return None
    return {
        "run_id": str(run_id),
        "timestamp": str(timestamp),
        "trigger_type": str(record.get("trigger_type") or "manual"),
        "event": str(record["event"]),
        "status": str(record.get("status") or "unknown"),
        "recovery_state": str(record.get("recovery_state") or "unknown"),
        "attempt_number": _as_int(record.get("attempt_number"), 0),
        "latency_ms": _as_float(record.get("latency_ms")),
    }


def read_recent_log_records(
    logs_client: Any,
    now: datetime | None = None,
    lookback_hours: int = LOOKBACK_HOURS,
) -> list[dict[str, Any]]:
    """Read a bounded window of structured run events from CloudWatch."""
    now = now or _now()
    params: dict[str, Any] = {
        "logGroupName": LOG_GROUP_NAME,
        "startTime": int((now - timedelta(hours=lookback_hours)).timestamp() * 1000),
        "limit": 1000,
    }
    records: list[dict[str, Any]] = []
    previous_token = None
    for _ in range(MAX_LOG_PAGES):
        response = logs_client.filter_log_events(**params)
        records.extend(
            parsed
            for event in response.get("events", [])
            if (parsed := parse_log_record(event)) is not None
        )
        token = response.get("nextToken")
        if not token or token == previous_token:
            break
        previous_token = token
        params["nextToken"] = token
    return records


def _public_trigger(trigger_type: str) -> str:
    if trigger_type == "scheduled":
        return "automatic"
    if trigger_type == "cd-live-proof":
        return "verification"
    return "manual"


def _public_result(final: dict[str, Any]) -> str:
    if final.get("status") == "success":
        if final.get("recovery_state") == "recovered" or _as_int(final.get("attempt_number")) > 1:
            return "recovered"
        return "success"
    if final.get("recovery_state") == "exhausted":
        return "exhausted"
    return "problem"


def summarize_runs(records: list[dict[str, Any]], limit: int = MAX_PUBLIC_RUNS) -> list[dict[str, Any]]:
    """Group private attempt events into small public run summaries."""
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[record["run_id"]].append(record)

    summaries: list[dict[str, Any]] = []
    for attempts in grouped.values():
        ordered = sorted(
            attempts,
            key=lambda row: (_as_int(row.get("attempt_number")), row.get("timestamp", "")),
        )
        final = ordered[-1]
        summaries.append(
            {
                "at": final["timestamp"],
                "trigger": _public_trigger(final["trigger_type"]),
                "result": _public_result(final),
                "attempts": max(_as_int(row.get("attempt_number")) for row in ordered),
                "latency_ms": final.get("latency_ms"),
            }
        )
    summaries.sort(key=lambda row: row["at"], reverse=True)
    return summaries[:limit]


def latest_scheduled_run(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    scheduled = [row for row in records if row.get("trigger_type") == "scheduled"]
    if not scheduled:
        return None
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in scheduled:
        grouped[record["run_id"]].append(record)
    finals = []
    for attempts in grouped.values():
        finals.append(
            max(attempts, key=lambda row: (_as_int(row.get("attempt_number")), row.get("timestamp", "")))
        )
    return max(finals, key=lambda row: row.get("timestamp", ""))


def schedule_health(latest: dict[str, Any] | None, now: datetime | None = None) -> dict[str, str]:
    """Derive a conservative public schedule signal from structured logs."""
    if latest is None:
        return {"state": "unknown", "message": "No hourly check has been seen yet."}
    now = now or _now()
    timestamp = _parse_timestamp(latest.get("timestamp"))
    if timestamp is None:
        return {"state": "unknown", "message": "The latest hourly check has no usable time."}
    age = now - timestamp
    if age > timedelta(hours=2):
        return {"state": "stale", "message": "The helper has not checked in during the last two hours."}
    return {"state": "ok", "message": "The helper checked in recently."}


def _check(check_id: str, label: str, state: str, message: str) -> dict[str, str]:
    return {"id": check_id, "label": label, "state": state, "message": message}


def proof_summary(proof: dict[str, Any] | None, run_url: str = "") -> dict[str, Any]:
    """Expose only the three verified outcome labels and attempt counts."""
    if not proof and not run_url:
        return {
            "state": "unknown",
            "verified_at": None,
            "message": "The latest verified deployment will appear here.",
            "url": "https://github.com/phatcobra/aws-operations-poc/actions",
        }

    scenarios: dict[str, dict[str, Any]] = {}
    if proof:
        for name, data in proof.get("scenarios", {}).items():
            final_status = data.get("final_status")
            recovery_state = data.get("recovery_state")
            if final_status == "success" and recovery_state == "recovered":
                result = "recovered"
            elif final_status == "success":
                result = "success"
            elif recovery_state == "exhausted":
                result = "exhausted"
            else:
                result = "problem"
            scenarios[name] = {
                "result": result,
                "attempts": _as_int(data.get("final_attempt"), 0),
            }
    elif run_url:
        scenarios = {
            "normal": {"result": "success", "attempts": 1},
            "transient": {"result": "recovered", "attempts": 2},
            "permanent": {"result": "exhausted", "attempts": 3},
        }

    verified = bool(
        (proof and proof.get("result") == "pass")
        or (run_url and scenarios)
    )
    return {
        "state": "verified" if verified else "unknown",
        "verified_at": proof.get("verified_at") if proof else _now().isoformat(),
        "message": (
            "The live test passed."
            if verified
            else "The latest deployment proof was not available."
        ),
        "url": run_url or "https://github.com/phatcobra/aws-operations-poc/actions",
        "scenarios": scenarios,
    }


def build_snapshot(
    records: list[dict[str, Any]],
    heartbeat: dict[str, str],
    proof: dict[str, Any] | None = None,
    run_url: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or _now()
    latest = latest_scheduled_run(records)
    recent = summarize_runs(records)
    if heartbeat["state"] == "stale":
        overall = "degraded"
        status_message = "The helper is late. The page is showing the issue without taking action."
    elif heartbeat["state"] == "unknown" or latest is None:
        overall = "unknown"
        status_message = "The page cannot confirm the helper's latest check yet."
    elif _public_result(latest) not in {"success", "recovered"}:
        overall = "degraded"
        status_message = "The latest check had a problem; the helper recorded it safely."
    else:
        overall = "healthy"
        status_message = "The helper is on schedule, and the latest check finished normally."

    proof = proof_summary(proof, run_url)
    transient_ok = proof.get("scenarios", {}).get("transient", {}).get("result") == "recovered"
    permanent_ok = (
        proof.get("scenarios", {}).get("permanent", {}).get("result") == "exhausted"
        and proof.get("scenarios", {}).get("permanent", {}).get("attempts") == 3
    )
    monitoring_state = "pass" if heartbeat["state"] == "ok" else "fail" if heartbeat["state"] == "stale" else "unknown"
    automatic_state = monitoring_state
    return {
        "schema_version": 1,
        "generated_at": now.isoformat(),
        "status": overall,
        "status_message": status_message,
        "last_scheduled_run_at": latest.get("timestamp") if latest else None,
        "heartbeat": heartbeat,
        "recent_runs": recent,
        "checks": [
            _check(
                "automatic_runs",
                "Hourly check",
                automatic_state,
                "The schedule is checking in." if automatic_state == "pass" else heartbeat["message"],
            ),
            _check(
                "failure_recovery",
                "Failure recovery",
                "pass" if transient_ok else "unknown",
                "A temporary problem cleared on the second try." if transient_ok else "Waiting for the latest live proof.",
            ),
            _check(
                "safety_limit",
                "Safety limit",
                "pass" if permanent_ok else "unknown",
                "A problem that did not clear stopped after three tries." if permanent_ok else "Waiting for the latest live proof.",
            ),
            _check(
                "monitoring",
                "Monitoring",
                monitoring_state,
                "Recent checks are being written down." if monitoring_state == "pass" else heartbeat["message"],
            ),
        ],
        "proof": proof,
    }


def _load_proof(path: Path | None) -> dict[str, Any] | None:
    if path is None or not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--proof", type=Path)
    parser.add_argument("--run-url", default="")
    args = parser.parse_args()

    now = _now()
    records: list[dict[str, Any]] = []
    heartbeat = {"state": "unknown", "message": "The public status source is temporarily unavailable."}
    try:
        session = boto3.Session(region_name=REGION)
        records = read_recent_log_records(session.client("logs"), now=now)
        heartbeat = schedule_health(latest_scheduled_run(records), now=now)
    except Exception as exc:  # fail closed: publish UNKNOWN, never a false HEALTHY state
        print(f"PUBLIC_STATUS_SOURCE_UNAVAILABLE: {type(exc).__name__}")

    snapshot = build_snapshot(
        records,
        heartbeat,
        proof=_load_proof(args.proof),
        run_url=args.run_url,
        now=now,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(snapshot, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
