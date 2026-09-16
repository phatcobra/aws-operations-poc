# AWS permission boundary (observed, 2026-09-16)

This documents what was empirically verified about the deploying identity's
permissions during the initial build of this POC. No credentials or secrets
are included below -- only ARNs, an AWS account ID, and IAM action names.

## Identity used to build and deploy

- Assumed role: `arn:aws:sts::660838763909:assumed-role/claude-poc-role/...`
  (`claude-poc` CLI profile, `us-east-2`)
- This identity is **CloudFormation-lifecycle-only**. It has no direct
  permissions on Lambda, DynamoDB, EventBridge, CloudWatch Logs, S3, or IAM
  (except `iam:GetRole` on the specific `aws-operations-poc-cfn-role`).

Confirmed **allowed** for this identity:
- `cloudformation:CreateStack`, `UpdateStack`, `DeleteStack`, `DescribeStacks`,
  `ValidateTemplate`, `GetTemplate` (scoped to `aws-operations-poc-*` stacks)
- `sts:GetCallerIdentity`
- `iam:GetRole` on `arn:aws:iam::660838763909:role/aws-operations-poc-cfn-role` only

Confirmed **denied** for this identity (all tested live against the account):
- `cloudformation:CreateChangeSet` / `ExecuteChangeSet` -- this is why
  `scripts/deploy.sh` calls `create-stack`/`update-stack` directly instead of
  `aws cloudformation deploy` (which always creates a changeset).
- `cloudformation:DescribeStackResources`, `ListStacks`
- `s3:CreateBucket`, `s3:ListAllMyBuckets`, `s3:PutObject` -- and critically,
  **the CloudFormation service role itself** (`aws-operations-poc-cfn-role`)
  is also not authorized for `s3:CreateBucket` (observed as a
  `CREATE_FAILED` resource event on a probe stack, since deleted). This is
  why the Lambda code is inlined via `AWS::Lambda::Function.Code.ZipFile`
  (see `scripts/render_template.py`) instead of packaged to S3: there is no
  permitted way to get a deployment package into S3 in this account.
- `lambda:GetFunction`, `lambda:InvokeFunction`, `lambda:ListFunctions`
- `dynamodb:DescribeTable`, `Scan`, `Query`, `ListTables`
- `logs:DescribeLogGroups`, `FilterLogEvents`
- `events:DescribeRule`, `ListTargetsByRule`, `ListRules`
- `iam:GetRole`/`ListAttachedRolePolicies`/`ListRolePolicies` on
  `aws-operations-poc-lambda-role` (readable only for `-cfn-role`)
- `iam:ListOpenIDConnectProviders` (could not confirm/deny whether a GitHub
  OIDC provider already exists in this account)

## Practical consequence

Everything created by `infra/template.yaml` was verified through
CloudFormation itself (`DescribeStacks` -> `CREATE_COMPLETE`, `GetTemplate`
byte-for-byte diffed against the locally rendered template) rather than
through each service's own API, because this identity cannot call those
service APIs directly.

**This identity cannot invoke the deployed Lambda or read the DynamoDB
table / CloudWatch Logs it writes to.** Live runtime evidence (a real
success record, a real transient-failure-then-recovery record, a real
exhausted-retry record) can only be captured by:

1. Waiting for the EventBridge schedule to fire the function autonomously
   (it will -- normal operation needs no additional permissions), or
2. Running `scripts/invoke_demo.sh` from an identity that has
   `lambda:InvokeFunction` on `aws-operations-poc-worker` and
   `dynamodb:Query` on `aws-operations-poc-runs`.

## Minimum action to unblock full runtime verification

Grant the deploying/verifying identity (or a separate read/invoke identity)
an inline policy scoped to this project's resources only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "lambda:InvokeFunction",
     "Resource": "arn:aws:lambda:us-east-2:660838763909:function:aws-operations-poc-*"},
    {"Effect": "Allow", "Action": ["dynamodb:Query", "dynamodb:Scan"],
     "Resource": "arn:aws:dynamodb:us-east-2:660838763909:table/aws-operations-poc-*"},
    {"Effect": "Allow", "Action": ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogStreams"],
     "Resource": "arn:aws:logs:us-east-2:660838763909:log-group:/aws/lambda/aws-operations-poc-*:*"}
  ]
}
```

This is a permission grant, which this project's operating rules say not to
make unilaterally (no IAM changes) -- it is listed here as the exact,
minimal action for a human operator to take if live runtime evidence beyond
the CloudFormation-verified deployment is required.

## GitHub Actions OIDC (CD)

`.github/workflows/cd.yml` assumes an AWS role via OIDC on every push to
`main`. That role (and the GitHub OIDC provider it trusts) does not exist
yet in this account and was not created here, per the same no-IAM-changes
rule. Bootstrapping it (one-time, human/IAM-admin action):

1. Create the OIDC provider for `token.actions.githubusercontent.com`
   (skip if one already exists for the account).
2. Create an IAM role trusted by that provider, condition-scoped to
   `repo:phatcobra/aws-operations-poc:ref:refs/heads/main`, with permissions
   limited to `cloudformation:CreateStack/UpdateStack/DescribeStacks/
   ValidateTemplate/GetTemplate` on `arn:aws:cloudformation:us-east-2:660838763909:stack/aws-operations-poc-*`
   and `iam:PassRole` limited to `arn:aws:iam::660838763909:role/aws-operations-poc-cfn-role`.
3. Store that role's ARN as the repository secret `AWS_DEPLOY_ROLE_ARN`.

Until then, `cd.yml`'s `test` job runs on every push to `main` (tests +
template rendering + `cfn-lint`); the `deploy` job will fail at the
credentials step with a clear error rather than doing anything silently.
