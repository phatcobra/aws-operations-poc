# Autonomous AWS Operations Lab

`aws-operations-poc` is a compact, deployed AWS operations project designed to prove that a small workload can be built, tested, deployed, observed, deliberately failed, automatically recovered, and audited end to end.

The neutral workload is weather data. The engineering demonstration is the point.

## What it proves

A push to `main` follows this path:

```text
GitHub change
→ deterministic tests
→ CloudFormation validation
→ GitHub OIDC authentication
→ AWS deployment
→ scheduled Lambda workload
→ public API call
→ structured CloudWatch logs + native Lambda metrics
→ DynamoDB execution evidence
→ controlled failure
→ bounded automatic recovery
→ machine-readable live proof artifact
```

## Architecture

```mermaid
flowchart LR
    G[GitHub main] --> CI[GitHub Actions CI]
    CI --> OIDC[GitHub OIDC]
    OIDC --> CFN[CloudFormation]
    CFN --> L[Lambda: aws-operations-poc-worker]
    EB[EventBridge: hourly] --> L
    L --> API[Open-Meteo public API]
    L --> DDB[(DynamoDB: aws-operations-poc-runs)]
    L --> CW[CloudWatch Logs + Lambda metrics]
    CD[CD live-proof step] --> L
    DDB --> CD
    CW --> CD
    CD --> A[GitHub Actions evidence artifact]
```

The deployed stack is `aws-operations-poc-main` in `us-east-2`.

## AWS resources

| Service | Resource | Purpose |
|---|---|---|
| Lambda | `aws-operations-poc-worker` | Python 3.12 workload and bounded recovery loop |
| EventBridge | `aws-operations-poc-schedule` | Hourly unattended execution |
| DynamoDB | `aws-operations-poc-runs` | Durable per-attempt evidence |
| CloudWatch Logs | `/aws/lambda/aws-operations-poc-worker` | Structured JSON operational logs |
| CloudWatch Metrics | Native Lambda metrics | Invocation/duration/platform health signals |
| CloudFormation | `aws-operations-poc-main` | Infrastructure as code and deployment boundary |
| GitHub Actions | CI + CD | Tests, validation, OIDC deployment, live proof |

All application resources use the `aws-operations-poc-` namespace and the project stays in `us-east-2`.

## Reliability behavior

The Lambda uses a strict bounded attempt loop (`MAX_ATTEMPTS=3`) with exponential backoff. It never creates an infinite retry path.

| Scenario | Expected behavior |
|---|---|
| normal | API succeeds on attempt 1; `recovery_state=not_needed` |
| transient | attempt 1 fails deterministically; attempt 2 succeeds; `recovery_state=recovered` |
| permanent | exactly 3 failed attempts; final `recovery_state=exhausted` |

The EventBridge target itself has `MaximumRetryAttempts: 0`, preventing platform retries from stacking on top of the function's bounded internal recovery policy.

## Persisted evidence

Every attempt is written to DynamoDB and emitted as structured JSON. The evidence contract includes:

```json
{
  "run_id": "...",
  "timestamp": "...",
  "trigger_type": "scheduled|manual|cd-live-proof",
  "attempt_number": 1,
  "external_request_result": "...",
  "status": "success|failure",
  "recovery_state": "not_needed|retrying|recovered|exhausted",
  "latency_ms": 12.3
}
```

The table key is `run_id + timestamp`, so all attempts for one invocation can be queried together.

## Automated live proof

`scripts/verify_live.py` is the final acceptance test. After deployment it:

1. invokes the real Lambda for normal, transient, and permanent scenarios;
2. queries DynamoDB with a consistent read;
3. asserts the exact persisted attempt sequence;
4. waits for CloudWatch log evidence for each `run_id`;
5. records the AWS assumed-role identity used for proof;
6. writes `live-evidence.json`;
7. GitHub Actions uploads that file as a 30-day workflow artifact.

A successful CD run therefore proves deployment and runtime behavior rather than merely proving that files exist.

## CI/CD

CI runs on pushes and pull requests and requires no AWS credentials. It installs dependencies, runs all deterministic offline unit tests, renders the deployable template from the tested source, and runs `cfn-lint`.

CD runs only on `main` under the `production` environment. It uses GitHub OIDC to assume:

```text
arn:aws:iam::660838763909:role/aws-operations-poc-github-deploy-role
```

No AWS access keys are stored in GitHub. The role ARN is intentionally public configuration; it is not a credential.

The AWS trust policy must match the repository's immutable environment subject exactly:

```text
repo:phatcobra@69565195/aws-operations-poc@1372530555:environment:production
```

See [`docs/AWS_BOUNDARY.md`](docs/AWS_BOUNDARY.md) for the exact least-privilege bootstrap policy and current verification state.

## Observability

Operational state is visible in three layers:

- structured CloudWatch Logs for run-level events and failure context;
- native Lambda CloudWatch metrics for invocation, duration, throttling, and platform-level errors;
- DynamoDB attempt records for durable, queryable success/failure/recovery evidence.

The deliberate application-level failures are handled inside the bounded recovery loop, so their authoritative outcome is the structured log/evidence contract rather than the Lambda `Errors` metric.

## Security model

- CloudFormation creates no IAM resources.
- The Lambda uses a pre-provisioned runtime role.
- CloudFormation uses a pre-provisioned service role.
- GitHub uses OIDC, not long-lived AWS keys.
- The GitHub deployment role is scoped to this project's CloudFormation stack and exact runtime-proof resources.
- The `production` GitHub environment is intended to be restricted to `main`.
- The public weather API requires no secret or API key.

## Cost controls

- Lambda: 128 MB, hourly schedule, 20-second timeout ceiling.
- DynamoDB: `PAY_PER_REQUEST`.
- CloudWatch Logs: 14-day retention.
- No NAT gateway, VPC, S3 deployment bucket, or always-on application compute.

## Run locally

```bash
pip install -r requirements-dev.txt
python3 -m unittest discover -s tests -v
python3 scripts/render_template.py
cfn-lint infra/template.rendered.yaml
```

Deployment:

```bash
bash scripts/deploy.sh
```

Live acceptance proof (requires the narrowly scoped invoke/query/log-read permissions documented in `docs/AWS_BOUNDARY.md`):

```bash
python3 scripts/verify_live.py --output live-evidence.json
```

## Repository layout

```text
src/                  Lambda workload
tests/                deterministic offline tests
infra/                CloudFormation
scripts/              render, deploy, manual/live verification
docs/                 security boundary and portfolio explanation
.github/workflows/     CI and CD
```

For an interview-oriented explanation and resume wording, see [`docs/PORTFOLIO.md`](docs/PORTFOLIO.md).
