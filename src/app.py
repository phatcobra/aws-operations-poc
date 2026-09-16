"""Lambda handler for the aws-operations-poc scheduled workload.

Fetches current weather from a public, keyless API (Open-Meteo), persists
structured run evidence to DynamoDB, emits structured JSON logs, and
supports deterministic fault injection to prove bounded automatic recovery.

Deployed inline (CloudFormation AWS::Lambda::Function Code.ZipFile, 4096-char
limit) so this file IS the deployed artifact -- no separate packaging step,
no build-time drift between what is tested and what runs in AWS. That limit
is why internal plumbing (helper params, loop-local names) is kept short
while the public API and every persisted/logged field name stays descriptive.
"""
import json
import os
import time
import uuid
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal

import boto3

TABLE_NAME = os.environ.get("TABLE_NAME", "")
API_URL = os.environ.get(
    "API_URL",
    "https://api.open-meteo.com/v1/forecast?latitude=40.7128&longitude=-74.0060&current=temperature_2m",
)
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("REQUEST_TIMEOUT_SECONDS", "3"))
BACKOFF_BASE_SECONDS = float(os.environ.get("BACKOFF_BASE_SECONDS", "0.5"))
FAULT_INJECTION_DEFAULT = os.environ.get("FAULT_INJECTION_DEFAULT", "false")

_dynamodb_resource = None
FaultError = RuntimeError  # real or simulated transient upstream failure


def _table():
    global _dynamodb_resource
    if _dynamodb_resource is None:
        _dynamodb_resource = boto3.resource("dynamodb")
    return _dynamodb_resource.Table(TABLE_NAME)


def fetch_current_weather(url=None, timeout=None):
    """Fetch current temperature from the public API. No API key required."""
    url = url or API_URL
    timeout = REQUEST_TIMEOUT_SECONDS if timeout is None else timeout
    req = urllib.request.Request(url, headers={"User-Agent": "aws-operations-poc"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        code = resp.getcode()
        body = resp.read().decode("utf-8")
    data = json.loads(body)
    cur = data.get("current")
    if not isinstance(cur, dict) or "temperature_2m" not in cur:
        raise ValueError("malformed API response: missing current.temperature_2m")
    return {"status_code": code, "temperature_c": cur["temperature_2m"]}


def _simulate_fault(mode, n):
    """Deterministic, bounded fault injection. Never loops on its own."""
    if mode == "transient" and n == 1:
        raise FaultError("simulated transient upstream failure (attempt 1)")
    if mode == "permanent":
        raise FaultError(f"simulated permanent upstream failure (attempt {n})")


def _trigger_type(event):
    if event.get("source") == "aws.events":
        return "scheduled"
    return str(event.get("trigger_type") or "manual")


def _fault_mode(event):
    mode = str(event.get("fault_injection", FAULT_INJECTION_DEFAULT)).strip().lower()
    return None if mode in ("", "false", "0", "none") else mode


def log_event(payload):
    print(json.dumps(payload, default=str))


def record_evidence(item):
    try:
        _table().put_item(Item={**item, "latency_ms": Decimal(str(item["latency_ms"]))})
    except Exception as exc:  # defensive: evidence write must never crash the run
        log_event({"event": "evidence_write_failed", "run_id": item.get("run_id"), "error": str(exc)})


def _evidence(rid, ts, trig, n, result, status, rec, latency_ms):
    """Build one evidence record. Field names here are the persisted/logged contract."""
    return {
        "run_id": rid,
        "timestamp": ts,
        "trigger_type": trig,
        "attempt_number": n,
        "external_request_result": result,
        "status": status,
        "recovery_state": rec,
        "latency_ms": latency_ms,
    }


def _persist(event_name, item, **extra):
    record_evidence(item)
    log_event({"event": event_name, **item, **extra})


def _ms(t0):
    return round((time.monotonic() - t0) * 1000, 2)


def handler(event, context):
    """Entry point. Runs one bounded attempt loop and always returns (never raises)."""
    event = event or {}
    rid = str(uuid.uuid4())
    trig = _trigger_type(event)
    fault_mode = _fault_mode(event)
    log_event({"event": "run_started", "run_id": rid, "trigger_type": trig, "fault_mode": fault_mode})

    item = None
    for n in range(1, MAX_ATTEMPTS + 1):
        t0 = time.monotonic()
        ts = datetime.now(timezone.utc).isoformat()
        try:
            _simulate_fault(fault_mode, n)
            res = fetch_current_weather()
            rec = "recovered" if n > 1 else "not_needed"
            item = _evidence(rid, ts, trig, n, json.dumps(res), "success", rec, _ms(t0))
            _persist("run_success", item)
            return {**item, "external_request_result": res}
        except Exception as exc:
            retry = n < MAX_ATTEMPTS
            rec = "retrying" if retry else "exhausted"
            item = _evidence(rid, ts, trig, n, str(exc), "failure", rec, _ms(t0))
            _persist("run_attempt_failed", item, will_retry=retry)
            if retry:
                time.sleep(BACKOFF_BASE_SECONDS * (2 ** (n - 1)))

    return item
