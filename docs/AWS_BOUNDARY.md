# AWS permission boundary and external bootstrap

This file records the security model and the remaining account-level bootstrap required by the public portfolio project. It contains identifiers and policy examples only; no credentials or secrets.

## Current verified state

The application stack `aws-operations-poc-main` previously reached `CREATE_COMPLETE` in `us-east-2`. Current repository CI passes the deterministic unit suite and CloudFormation linting.

GitHub Actions now obtains a real OIDC token and records only non-secret trust claims. The claims were empirically observed from the `production` deployment job:

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

The workflow supplies the explicit role ARN, but AWS currently rejects the exchange with:

```text
Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity
```

Therefore the remaining CD blocker is specifically the AWS OIDC provider / trust configuration for the project GitHub role, not a missing GitHub secret or an uncertain subject claim.

## Project roles

```text
Cloud workstation/deployer: arn:aws:iam::660838763909:role/claude-poc-role
CloudFormation service role: arn:aws:iam::660838763909:role/aws-operations-poc-cfn-role
Lambda runtime role:        arn:aws:iam::660838763909:role/aws-operations-poc-lambda-role
GitHub CD role:              arn:aws:iam::660838763909:role/aws-operations-poc-github-deploy-role
```

The application CloudFormation stack creates no IAM resources.

## Required GitHub OIDC trust

The account must contain the OIDC provider:

```text
https://token.actions.githubusercontent.com
```

with audience/client ID:

```text
sts.amazonaws.com
```

The trust policy on `aws-operations-poc-github-deploy-role` must be:

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

The GitHub `production` environment should permit deployment from `main` only.

## Required GitHub CD role permissions

The CD role deploys only the project stack through the existing CloudFormation service role and then performs the live acceptance proof against exact project resources.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PocStackLifecycle",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:GetTemplate"
      ],
      "Resource": "arn:aws:cloudformation:us-east-2:660838763909:stack/aws-operations-poc-*/*"
    },
    {
      "Sid": "ValidateTemplate",
      "Effect": "Allow",
      "Action": "cloudformation:ValidateTemplate",
      "Resource": "*"
    },
    {
      "Sid": "PassOnlyPocCloudFormationRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::660838763909:role/aws-operations-poc-cfn-role",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "cloudformation.amazonaws.com"
        }
      }
    },
    {
      "Sid": "InvokeProofFunction",
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "arn:aws:lambda:us-east-2:660838763909:function:aws-operations-poc-worker"
    },
    {
      "Sid": "ReadProofEvidence",
      "Effect": "Allow",
      "Action": "dynamodb:Query",
      "Resource": "arn:aws:dynamodb:us-east-2:660838763909:table/aws-operations-poc-runs"
    },
    {
      "Sid": "ReadProofLogs",
      "Effect": "Allow",
      "Action": "logs:FilterLogEvents",
      "Resource": "arn:aws:logs:us-east-2:660838763909:log-group:/aws/lambda/aws-operations-poc-worker:*"
    }
  ]
}
```

`sts:GetCallerIdentity` is used only to record the assumed-role ARN in the evidence artifact.

## CloudFormation service-role addition for heartbeat detection

The stack now defines one native-metric CloudWatch alarm named `aws-operations-poc-heartbeat-stale`. It watches the Lambda `Invocations` metric and treats two consecutive one-hour periods with fewer than one invocation as stale. The alarm has no actions; its state is the health signal, so no SNS topic or notification infrastructure is needed.

The existing `aws-operations-poc-cfn-role` therefore also needs this narrowly scoped statement:

```json
{
  "Effect": "Allow",
  "Action": [
    "cloudwatch:PutMetricAlarm",
    "cloudwatch:DeleteAlarms",
    "cloudwatch:DescribeAlarms"
  ],
  "Resource": "arn:aws:cloudwatch:us-east-2:660838763909:alarm:aws-operations-poc-heartbeat-stale"
}
```

## Runtime proof

Once the OIDC trust and permissions above are active, `.github/workflows/cd.yml` automatically deploys and runs `scripts/verify_live.py`. It proves:

- normal success on attempt 1;
- transient failure followed by bounded recovery on attempt 2;
- permanent failure ending exactly at attempt 3 with `recovery_state=exhausted`;
- persisted DynamoDB attempt history matches those exact transitions;
- CloudWatch contains matching structured events for each run.

The verifier writes `live-evidence.json`; GitHub Actions uploads it as a workflow artifact tied to the commit SHA. The same workflow always uploads `oidc-claims.json`, so authentication failures remain diagnosable without exposing the OIDC token itself.

## Existing workstation deploy boundary

The `claude-poc-role` remains intentionally narrow. Direct runtime verification does not need to be added to that role because GitHub CD owns deployment acceptance and live proof once OIDC is active.

## Cost and blast-radius controls

- Region: `us-east-2`.
- Stack namespace: `aws-operations-poc-*`.
- Runtime resources: exact project Lambda, table, schedule, log group, and heartbeat alarm.
- One standard CloudWatch alarm; no custom metric is introduced for heartbeat detection.
- No long-lived AWS keys in GitHub.
- No IAM resources created by the application stack.
- No S3 deployment bucket, NAT gateway, or always-on application compute.
