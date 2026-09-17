# AWS permission boundary and bootstrap

This document records the verified security boundary for the public portfolio POC. It contains identifiers and policy examples only; no credentials or secrets.

## Current verified state

The application stack `aws-operations-poc-main` is deployed in `us-east-2` and the end-to-end CD path is working.

Verified production proof:

- commit: [`35f0c05287e71d28e95416c415d7d29e4fc7aede`](https://github.com/phatcobra/aws-operations-poc/commit/35f0c05287e71d28e95416c415d7d29e4fc7aede)
- successful CD run: [35247841207](https://github.com/phatcobra/aws-operations-poc/actions/runs/35247841207)
- verifier result: `pass`
- deployment identity: `arn:aws:sts::660838763909:assumed-role/aws-operations-poc-github-deploy-role/GitHubActions`
- CloudWatch operator dashboard: `aws-operations-poc-operations`

That run successfully completed OIDC authentication, CloudFormation deployment, live normal/transient/permanent execution proof, DynamoDB evidence verification, CloudWatch log verification, and proof-artifact upload.

GitHub Actions records only non-secret OIDC trust claims. The observed claims for the verified production deployment were:

```json
{
  "iss": "https://token.actions.githubusercontent.com",
  "aud": "sts.amazonaws.com",
  "sub": "repo:phatcobra@69565195/aws-operations-poc@1372530555:environment:production",
  "repository": "phatcobra/aws-operations-poc",
  "repository_id": "1372530555",
  "repository_owner": "phatcobra",
  "repository_owner_id": "69565195",
  "environment": "production",
  "ref": "refs/heads/main"
}
```

The earlier `sts:AssumeRoleWithWebIdentity` failure is resolved. AWS now accepts the exact GitHub OIDC subject above and the production workflow assumes the project deployment role successfully.

## Project roles

```text
Cloud workstation/deployer: arn:aws:iam::660838763909:role/claude-poc-role
CloudFormation service role: arn:aws:iam::660838763909:role/aws-operations-poc-cfn-role
Lambda runtime role:        arn:aws:iam::660838763909:role/aws-operations-poc-lambda-role
GitHub CD role:              arn:aws:iam::660838763909:role/aws-operations-poc-github-deploy-role
```

The application CloudFormation stack creates no IAM resources.

## GitHub OIDC trust

The account contains the GitHub OIDC provider for:

```text
https://token.actions.githubusercontent.com
```

with audience/client ID:

```text
sts.amazonaws.com
```

The trust policy on `aws-operations-poc-github-deploy-role` is scoped to the empirically observed production subject:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::660838763909:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:phatcobra@69565195/aws-operations-poc@1372530555:environment:production"
        }
      }
    }
  ]
}
```

The GitHub `production` environment is restricted to `main`.

## GitHub CD role permissions

The CD role can deploy the project stack through the existing CloudFormation service role and perform live acceptance proof against the exact project resources. The bootstrap source of truth is `scripts/bootstrap_admin.ps1`.

The deployment boundary includes:

- CloudFormation lifecycle operations on `aws-operations-poc-*` stacks, gated to the project CloudFormation service role;
- `cloudformation:ValidateTemplate`;
- `iam:PassRole` only for `aws-operations-poc-cfn-role` to CloudFormation;
- `lambda:InvokeFunction` only for `aws-operations-poc-worker`;
- `dynamodb:Query` only for `aws-operations-poc-runs`;
- `logs:FilterLogEvents` only for `/aws/lambda/aws-operations-poc-worker`.

`sts:GetCallerIdentity` is used only to record the assumed-role ARN in the evidence artifact.

## CloudFormation observability authority

The stack manages two CloudWatch observability resources:

```text
aws-operations-poc-heartbeat-stale
aws-operations-poc-operations
```

The CloudFormation service role has project-scoped authority to manage the exact heartbeat alarm and exact dashboard. The bootstrap policy grants:

```text
cloudwatch:PutMetricAlarm
cloudwatch:DeleteAlarms
cloudwatch:DescribeAlarms
cloudwatch:PutDashboard
cloudwatch:GetDashboard
cloudwatch:DeleteDashboards
```

against the corresponding project alarm/dashboard ARNs.

The heartbeat alarm watches the native Lambda `Invocations` metric and treats two consecutive one-hour periods with fewer than one invocation as stale. It has no actions attached; its state is the health signal.

The dashboard is CloudFormation-managed and surfaces workload health, latency, heartbeat state, recent execution attempts, and recovery outcomes without introducing always-on UI compute.

## Runtime proof

`.github/workflows/cd.yml` deploys the stack and runs `scripts/verify_live.py` automatically after deployment.

The verified production run proved:

- normal success on attempt 1;
- transient failure followed by bounded recovery on attempt 2;
- permanent failure ending exactly at attempt 3 with `recovery_state=exhausted`;
- persisted DynamoDB attempt history matched the exact expected transitions;
- matching CloudWatch structured events were present for every scenario.

The successful proof artifact contains `live-evidence.json` and non-secret `oidc-claims.json`. The artifact is tied to the deployed commit and retained by GitHub Actions for 30 days.

## Cost and blast-radius controls

- Region: `us-east-2`.
- Stack namespace: `aws-operations-poc-*`.
- Runtime resources: exact project Lambda, table, schedule, log group, heartbeat alarm, and operator dashboard.
- One standard CloudWatch alarm; no custom metric is introduced for heartbeat detection.
- The dashboard reuses native metrics and existing logs.
- No long-lived AWS keys in GitHub.
- No IAM resources created by the application stack.
- No S3 deployment bucket, NAT gateway, VPC, or always-on application compute.
