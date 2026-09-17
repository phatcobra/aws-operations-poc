# Portfolio explanation

## 30-second version

I built and deployed a small AWS operations lab that authenticates from GitHub through OIDC, runs a Python Lambda on an EventBridge schedule, calls a public API, persists per-attempt evidence to DynamoDB, emits structured CloudWatch logs, and deliberately injects failures to prove bounded automatic recovery. The system also exposes a CloudFormation-managed CloudWatch operator dashboard for health, latency, heartbeat state, recent attempts, and recovery outcomes. The CD pipeline does not stop at deployment: it invokes the real workload in normal, transient-failure, and permanent-failure modes, verifies the exact DynamoDB history and CloudWatch logs, and stores the result as a GitHub Actions evidence artifact.

## Verified deployment

Production proof is available from the successful GitHub Actions CD run for commit `35f0c05287e71d28e95416c415d7d29e4fc7aede`:

- run: https://github.com/phatcobra/aws-operations-poc/actions/runs/35247841207
- result: `pass`
- deployment identity: `aws-operations-poc-github-deploy-role/GitHubActions`
- dashboard: `aws-operations-poc-operations`

The live proof verified:

```text
normal    → attempt 1 success → not_needed
transient → attempt 1 failure → attempt 2 success → recovered
permanent → attempts 1-3 failure → exhausted → STOP
```

## What an interviewer can verify

- Infrastructure is defined in CloudFormation.
- CI runs deterministic offline tests and `cfn-lint`.
- AWS authentication is GitHub OIDC, not stored AWS access keys.
- The runtime is scheduled and unattended.
- CloudWatch provides a native operator dashboard rather than relying only on logs.
- Heartbeat staleness is monitored with a native Lambda metric alarm.
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

## Operator experience

The CloudWatch dashboard `aws-operations-poc-operations` is the operational UI for the project. It shows Lambda health, duration, heartbeat/schedule health, recent structured execution attempts, and focused recovery outcomes. Because it is defined in CloudFormation, the UI is reproducible and deployed through the same CI/CD path as the workload.

## Skills demonstrated

AWS Lambda, EventBridge, DynamoDB, CloudWatch Dashboards, CloudWatch Logs and Metrics, CloudFormation, IAM/OIDC, Python, Git/GitHub, GitHub Actions CI/CD, structured logging, deterministic testing, failure injection, bounded retry/backoff, operational evidence, cost control, and least-privilege design.

## Resume bullet

Built and deployed an AWS operations lab using Python, Lambda, EventBridge, DynamoDB, CloudWatch, CloudFormation, and GitHub Actions; implemented OIDC-based CI/CD, a CloudFormation-managed operator dashboard, deterministic failure injection, bounded automatic recovery, structured observability, and automated live post-deployment evidence verification.

## Shorter resume bullet

Built an event-driven AWS workload with GitHub OIDC CI/CD, CloudFormation, CloudWatch monitoring/dashboarding, deterministic failure injection, bounded recovery, and auditable runtime evidence.

## Interview talking points

**Why weather data?**  The domain is intentionally simple and public. The project is about operating a reliable AWS workload, not building a complex data product.

**Why DynamoDB evidence if CloudWatch already logs?**  Logs are operational telemetry; DynamoDB provides a durable queryable attempt history grouped by `run_id`. The two evidence paths make recovery behavior independently inspectable.

**Why no platform retry on EventBridge?**  The Lambda owns a single bounded retry policy. Disabling EventBridge target retries prevents multiplicative retry behavior and makes the maximum number of attempts deterministic.

**How is deployment authenticated?**  GitHub requests a short-lived OIDC token and assumes one AWS role scoped to this repository/environment. No static AWS access key is stored in GitHub.

**How do you prove it works?**  The CD pipeline invokes the deployed function in three modes, asserts the exact DynamoDB sequence, verifies matching CloudWatch events, and uploads a JSON evidence artifact tied to the commit SHA.

**Why use a CloudWatch dashboard instead of building a custom frontend?**  This is an operations project, so the native AWS operator interface gives the highest signal with the least extra architecture. It directly exposes the metrics, alarm state, and structured execution evidence the system is designed to operate.

**How is cost controlled?**  The workload runs hourly at 128 MB, DynamoDB is on-demand, logs expire after 14 days, the dashboard reuses existing CloudWatch telemetry, and the design avoids always-on application compute and network infrastructure.
