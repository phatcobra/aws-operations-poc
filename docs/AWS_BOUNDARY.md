# AWS permission boundary and external bootstrap

This file records the security model and the remaining account-level bootstrap required by the public portfolio project. It contains identifiers and policy examples only; no credentials or secrets.

## Current verified state

The application stack `aws-operations-poc-main` has previously reached `CREATE_COMPLETE` in `us-east-2`, and repository CI passes its deterministic tests and CloudFormation linting.

The latest authenticated GitHub Actions test of the explicit deployment role reached the OIDC step and failed with:

```text
Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity
```

That result is useful: the workflow now supplies a concrete `role-to-assume` ARN, so the remaining CD blocker is on the AWS OIDC provider/trust-policy side rather than a missing GitHub secret.

## Roles

Existing project roles:

```text
Cloud workstation/deployer: arn:aws:iam::660838763909:role/claude-poc-role
CloudFormation service role: arn:aws:iam::660838763909:role/aws-operations-poc-cfn-role
Lambda runtime role:        arn:aws:iam::660838763909:role/aws-operations-poc-lambda-role
GitHub CD role:              arn:aws:iam::660838763909:role/aws-operations-poc-github-deploy-role
```

The CloudFormation template itself creates no IAM resources.

## GitHub OIDC trust

The deploy job runs under GitHub environment `production`. The repository uses GitHub's immutable OIDC subject format. The AWS trust policy must match this subject exactly:

```text
repo:phatcobra@69565195/aws-operations-poc@1372530555:environment:production
```

The account must contain the OIDC provider for:

```text
https://token.actions.githubusercontent.com
```

with audience/client ID:

```text
sts.amazonaws.com
```

Minimum trust policy for `aws-operations-poc-github-deploy-role`:

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

The GitHub `production` environment should allow deployment from `main` only.

## Minimum GitHub CD role permissions

The CD role needs two narrowly scoped capability groups: deploy the one project stack through the existing CloudFormation service role, and prove the deployed runtime behavior.

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

`sts:GetCallerIdentity` is used only to record the assumed-role ARN in the evidence artifact; AWS permits that identity call without a resource-scoped allow statement.

## Runtime proof

Once OIDC trust and the permissions above are active, `.github/workflows/cd.yml` automatically runs `scripts/verify_live.py` after deployment. It verifies all three scenarios against the real AWS resources:

- normal success on attempt 1;
- transient failure followed by bounded recovery on attempt 2;
- permanent failure ending exactly at attempt 3 with `recovery_state=exhausted`.

The verifier uses a consistent DynamoDB query, waits for matching CloudWatch log events, and writes `live-evidence.json`. GitHub Actions uploads that file as a workflow artifact.

This removes the need to broaden the cloud-workstation deploy identity merely to collect runtime proof.

## Existing workstation deploy boundary

The `claude-poc-role` remains intentionally narrow. It was verified to support the project CloudFormation lifecycle while direct Lambda invocation and direct DynamoDB/CloudWatch evidence reads were denied. That is acceptable once GitHub CD owns deployment acceptance and live proof.

## Cost and blast-radius controls

- Region: `us-east-2`.
- Stack namespace: `aws-operations-poc-*`.
- Runtime resources: exact project Lambda, table, schedule, and log group.
- No long-lived AWS keys in GitHub.
- No IAM resources created by the application stack.
- No S3 deployment bucket, NAT gateway, or always-on application compute.
