#!/usr/bin/env bash
# Exercise the three demonstration scenarios against the deployed Lambda and
# print the resulting DynamoDB evidence for each.
#
# Requires an identity with lambda:InvokeFunction on aws-operations-poc-worker
# and dynamodb:Query on aws-operations-poc-runs (the aws-operations-poc-cfn /
# claude-poc deploy identity intentionally does NOT have these -- see
# docs/AWS_BOUNDARY.md).
set -euo pipefail

FUNCTION_NAME="aws-operations-poc-worker"
TABLE_NAME="aws-operations-poc-runs"
REGION="us-east-2"
OUT_DIR="$(mktemp -d)"

invoke() {
  local label="$1" payload="$2"
  echo "==> Invoking ($label): $payload"
  aws lambda invoke \
    --region "$REGION" \
    --function-name "$FUNCTION_NAME" \
    --cli-binary-format raw-in-base64-out \
    --payload "$payload" \
    "$OUT_DIR/$label.json" >/dev/null
  echo "    response: $(cat "$OUT_DIR/$label.json")"
  run_id="$(python3 -c "import json;print(json.load(open('$OUT_DIR/$label.json'))['run_id'])")"
  echo "    evidence for run_id=$run_id:"
  aws dynamodb query \
    --region "$REGION" \
    --table-name "$TABLE_NAME" \
    --key-condition-expression "run_id = :r" \
    --expression-attribute-values "{\":r\":{\"S\":\"$run_id\"}}" \
    --output json | python3 -c "import json,sys; [print('     ', i) for i in json.load(sys.stdin)['Items']]"
  echo
}

echo "### Scenario 1: normal success ###"
invoke "normal" '{"trigger_type":"manual-demo"}'

echo "### Scenario 2: controlled transient failure -> bounded automatic recovery ###"
invoke "transient" '{"trigger_type":"manual-demo","fault_injection":"transient"}'

echo "### Scenario 3: permanent failure -> bounded retry exhaustion (no infinite loop) ###"
invoke "permanent" '{"trigger_type":"manual-demo","fault_injection":"permanent"}'

echo "Done. Raw responses saved under $OUT_DIR"
