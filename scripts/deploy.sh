#!/usr/bin/env bash
# Deploy the aws-operations-poc-main CloudFormation stack.
#
# Uses `create-stack`/`update-stack` directly rather than `cloudformation
# deploy`, because the deploying identity is authorized for CreateStack /
# UpdateStack / DescribeStacks but NOT for CreateChangeSet (verified against
# the live account: `deploy` fails with AccessDenied on CreateChangeSet even
# though CreateStack succeeds for the same stack name).
#
# Fails closed: any AWS CLI error aborts the script (set -e), and a failed
# create/update leaves the stack in a CloudFormation-managed rollback state
# rather than a half-applied one.
set -euo pipefail

STACK_NAME="aws-operations-poc-main"
REGION="us-east-2"
CFN_ROLE_ARN="arn:aws:iam::660838763909:role/aws-operations-poc-cfn-role"
TEMPLATE_SRC="$(dirname "$0")/../infra/template.yaml"
TEMPLATE_RENDERED="$(dirname "$0")/../infra/template.rendered.yaml"
RENDER_SCRIPT="$(dirname "$0")/render_template.py"

export AWS_REGION="$REGION"

echo "==> Running tests"
python3 -m unittest discover -s "$(dirname "$0")/../tests" -v

echo "==> Rendering template (inlining src/app.py)"
python3 "$RENDER_SCRIPT"

echo "==> Validating rendered template"
aws cloudformation validate-template --template-body "file://$TEMPLATE_RENDERED" >/dev/null

STACK_STATUS="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "MISSING")"
echo "==> Current stack status: $STACK_STATUS"

if [[ "$STACK_STATUS" == "MISSING" ]]; then
  ACTION="create-stack"
elif [[ "$STACK_STATUS" == "ROLLBACK_COMPLETE" ]]; then
  echo "==> Stack is in ROLLBACK_COMPLETE; deleting before recreate"
  aws cloudformation delete-stack --stack-name "$STACK_NAME" --role-arn "$CFN_ROLE_ARN"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
  ACTION="create-stack"
else
  ACTION="update-stack"
fi

echo "==> $ACTION on $STACK_NAME"
set +e
OUT="$(aws cloudformation "$ACTION" \
  --stack-name "$STACK_NAME" \
  --template-body "file://$TEMPLATE_RENDERED" \
  --role-arn "$CFN_ROLE_ARN" \
  --tags Key=Project,Value=aws-operations-poc \
  2>&1)"
STATUS=$?
set -e
if [[ $STATUS -ne 0 ]]; then
  if echo "$OUT" | grep -q "No updates are to be performed"; then
    echo "==> No changes to deploy."
    exit 0
  fi
  echo "$OUT" >&2
  exit "$STATUS"
fi
echo "$OUT"

WAIT_FOR="stack-create-complete"
[[ "$ACTION" == "update-stack" ]] && WAIT_FOR="stack-update-complete"

echo "==> Waiting for $WAIT_FOR"
aws cloudformation wait "$WAIT_FOR" --stack-name "$STACK_NAME"

echo "==> Deploy complete. Stack outputs:"
aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query 'Stacks[0].Outputs' --output table
