# Portfolio explanation

## 30-second version

I built a small AWS operations lab that deploys from GitHub through OIDC, runs a Python Lambda on an EventBridge schedule, calls a public API, persists per-attempt evidence to DynamoDB, emits structured CloudWatch logs, and deliberately injects failures to prove bounded automatic recovery. The CD pipeline does not stop at deployment: it invokes the real workload in normal, transient-failure, and permanent-failure modes, verifies the exact DynamoDB history and CloudWatch logs, and stores the result as a GitHub Actions evidence artifact.

## What an interviewer can verify

- Infrastructure is defined in CloudFormation.
- CI runs deterministic offline tests and `cfn-lint`.
- AWS authentication is GitHub OIDC, not stored AWS access keys.
- The runtime is scheduled and unattended.
- Failures are intentional and deterministic.
- Retry count is strictly bounded.
- Every attempt is durable evidence, not just console output.
- CD performs a live acceptance test after deployment.
- Cost and IAM scope are deliberately constrained.

## Failure demonstration

Normal:

```text
attempt 1 → success → not_needed
```

Transient:

```text
attempt 1 → failure → retrying
attempt 2 → success → recovered
```

Permanent:

```text
attempt 1 → failure → retrying
attempt 2 → failure → retrying
attempt 3 → failure → exhausted
STOP
```

The permanent scenario is as important as the successful recovery: it proves the system does not retry forever.

## Skills demonstrated

AWS Lambda, EventBridge, DynamoDB, CloudWatch, CloudFormation, IAM/OIDC, Python, Git/GitHub, GitHub Actions CI/CD, structured logging, deterministic testing, failure injection, bounded retry/backoff, operational evidence, cost control, and least-privilege design.

## Resume bullet

Built and deployed an AWS operations lab using Python, Lambda, EventBridge, DynamoDB, CloudWatch, CloudFormation, and GitHub Actions; implemented OIDC-based CI/CD, deterministic failure injection, bounded automatic recovery, structured observability, and automated live post-deployment evidence verification.

## Shorter resume bullet

Built an event-driven AWS workload with GitHub OIDC CI/CD, CloudFormation, monitoring, deterministic failure injection, bounded recovery, and auditable runtime evidence.

## Interview talking points

**Why weather data?**  The domain is intentionally simple and public. The project is about operating a reliable AWS workload, not building a complex data product.

**Why DynamoDB evidence if CloudWatch already logs?**  Logs are operational telemetry; DynamoDB provides a durable queryable attempt history grouped by `run_id`. The two evidence paths make recovery behavior independently inspectable.

**Why no platform retry on EventBridge?**  The Lambda owns a single bounded retry policy. Disabling EventBridge target retries prevents multiplicative retry behavior and makes the maximum number of attempts deterministic.

**How is deployment authenticated?**  GitHub requests a short-lived OIDC token and assumes one AWS role scoped to this repository/environment. No static AWS access key is stored in GitHub.

**How do you prove it works?**  The CD pipeline invokes the deployed function in three modes, asserts the exact DynamoDB sequence, verifies matching CloudWatch events, and uploads a JSON evidence artifact tied to the commit SHA.

**How is cost controlled?**  The workload runs hourly at 128 MB, DynamoDB is on-demand, logs expire after 14 days, and the design avoids always-on application compute and network infrastructure.
