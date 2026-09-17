# Autonomous AWS Operations Lab

[![CI](https://github.com/phatcobra/aws-operations-poc/actions/workflows/ci.yml/badge.svg)](https://github.com/phatcobra/aws-operations-poc/actions/workflows/ci.yml)
[![CD](https://github.com/phatcobra/aws-operations-poc/actions/workflows/cd.yml/badge.svg)](https://github.com/phatcobra/aws-operations-poc/actions/workflows/cd.yml)

`aws-operations-poc` is a compact AWS operations project designed to prove that a small workload can be built, tested, deployed, observed, deliberately failed, automatically recovered, and audited end to end.

The neutral workload is weather data. The engineering demonstration is the point.

## Verified production deployment

The POC is deployed and verified in `us-east-2`.

- CloudFormation stack: `aws-operations-poc-main`
- Operator UI: CloudWatch dashboard `aws-operations-poc-operations`
- Verified commit: [`35f0c052`](https://github.com/phatcobra/aws-operations-poc/commit/35f0c05287e71d28e95416c415d7d29e4fc7aede)
- Successful CD/live-proof run: [GitHub Actions run 35247841207](https://github.com/phatcobra/aws-operations-poc/actions/runs/35247841207)
- Live verifier result: `pass`
- Deployment identity: `aws-operations-poc-github-deploy-role/GitHubActions`

The live proof executed all three operational scenarios against AWS:

| Scenario | Verified result |
|---|---|
| normal | success on attempt 1; `not_needed` |
| transient | failure on attempt 1, success on attempt 2; `recovered` |
| permanent | exactly 3 failed attempts; `exhausted` |

The proof artifact for that run contains the non-secret OIDC claims plus `live-evidence.json`, including the exact DynamoDB attempt sequence and matching CloudWatch log-event counts.

## End-to-end path

```text
GitHub change
→ deterministic tests
→ CloudFormation validation
→ GitHub OIDC authentication
→ AWS deployment
→ scheduled Lambda workload
→ public API call
→ CloudWatch logs + metrics + heartbeat alarm
→ CloudWatch operator dashboard
→ simple public Hourly Helper page
→ DynamoDB execution evidence
→ controlled failure
→ automatic bounded recovery
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
    CW --> H[Heartbeat staleness alarm]
    CW --> UI[CloudWatch operator dashboard]
    H --> UI
    CD[CD live-proof step] --> L
    DDB --> CD
    CW --> CD
    CD --> A[GitHub Actions evidence artifact]
```

The stack is `aws-operations-poc-main` in `us-east-2`.

## AWS resources

| Service | Resource | Purpose |
|---|---|---|
| Lambda | `aws-operations-poc-worker` | Python 3.12 workload and bounded recovery loop |
| EventBridge | `aws-operations-poc-schedule` | Hourly unattended execution |
| DynamoDB | `aws-operations-poc-runs` | Durable per-attempt evidence |
| CloudWatch Logs | `/aws/lambda/aws-operations-poc-worker` | Structured JSON operational logs |
| CloudWatch Metrics | Native Lambda metrics | Invocation/duration/platform health signals |
| CloudWatch Alarm | `aws-operations-poc-heartbeat-stale` | Detects two consecutive missing hourly invocations |
| CloudWatch Dashboard | `aws-operations-poc-operations` | Operator UI for health, latency, recent attempts, and recovery outcomes |
| GitHub Pages | The Hourly Helper page | A simple read-only explanation of the automatic check |
| CloudFormation | `aws-operations-poc-main` | Infrastructure as code and deployment boundary |
| GitHub Actions | CI + CD | Tests, validation, OIDC deployment, live proof |

All application resources use the `aws-operations-poc-` namespace.

## Operator dashboard

The native CloudWatch dashboard `aws-operations-poc-operations` is the operator-facing UI for the POC. It is created and updated by CloudFormation rather than maintained manually.

It shows:

- Lambda invocations, errors, and throttles;
- average Lambda duration;
- heartbeat/schedule health through the `aws-operations-poc-heartbeat-stale` alarm;
- recent structured execution attempts;
- focused `recovered` and `exhausted` outcomes.

The recent-run tables use the same structured CloudWatch events validated by the CD live-proof step. Durable attempt history remains in DynamoDB.

## The Hourly Helper public page

The repository also contains a static, read-only page for people who do not know AWS and do not have AWS Console access. It explains the system as one familiar story: an hourly helper asks for the weather, writes down what happened, tries again when a temporary problem makes sense, and stops after three tries.

The page is designed to be narrated from top to bottom:

- **Right now** says whether the helper is working and when it last checked;
- **What the helper does** walks through six numbered steps, each with a sentence the presenter can say out loud;
- **Recent checks** shows what the helper actually did recently in plain language;
- **When something goes wrong** explains the three-try safety rule;
- **We tested the rule** shows proof that normal, recovery, and stop behavior were exercised;
- **The computer version** is optional for visitors who want the AWS names.

The status snapshot is generated by the public-site workflow from the existing Lambda log group through the project-scoped GitHub OIDC role. It copies no raw logs, run IDs, ARNs, credentials, or error details into the public site. The page makes no AWS calls and has no invoke, fault-injection, or mutation controls. The CloudWatch dashboard remains the detailed operator interface.

The public-site workflow publishes the `site/` directory to GitHub Pages after successful CD, with manual dispatch available for a status refresh. GitHub Pages is configured to use **Source: GitHub Actions**.

## Reliability behavior

The Lambda uses a strict bounded attempt loop (`MAX_ATTEMPTS=3`) with exponential backoff. It cannot retry forever.

| Scenario | Expected behavior |
|---|---|
| normal | API succeeds on attempt 1; `recovery_state=not_needed` |
| transient | attempt 1 fails deterministically; attempt 2 succeeds; `recovery_state=recovered` |
| permanent | exactly 3 failed attempts; final `recovery_state=exhausted` |

The EventBridge target has `MaximumRetryAttempts: 0`, preventing platform retries from multiplying the function's own bounded recovery policy.

The heartbeat alarm separately watches the native Lambda `Invocations` metric. If the hourly workload receives fewer than one invocation in two consecutive one-hour periods, missing data is treated as breaching and the alarm enters `ALARM`. It has no actions attached; the alarm state itself is the staleness/health signal.

## Persisted evidence

Every attempt is written to DynamoDB and emitted as structured JSON:

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

`run_id + timestamp` is the DynamoDB key, so all attempts for one invocation are queryable as a group.

## Automated live proof

`scripts/verify_live.py` is the post-deployment acceptance test. It:

1. invokes the real Lambda in normal, transient, and permanent modes;
2. queries DynamoDB with a consistent read;
3. asserts the exact persisted attempt sequence;
4. waits for matching CloudWatch log events for each `run_id`;
5. records the AWS assumed-role identity used for proof;
6. writes `live-evidence.json`;
7. GitHub Actions uploads the file as a 30-day artifact.

The CD workflow also captures only non-secret GitHub OIDC claims into `oidc-claims.json`, making trust-policy failures diagnosable without exposing the token.

A successful CD run therefore proves deployed behavior rather than merely proving that files exist.

## CI/CD

CI runs on pushes and pull requests without AWS credentials. It installs dependencies, runs deterministic offline unit tests, renders the deployable CloudFormation template from the tested Lambda source, and runs `cfn-lint`.

CD runs only on `main` under the `production` environment. It uses GitHub OIDC to assume:

```text
arn:aws:iam::660838763909:role/aws-operations-poc-github-deploy-role
```

No AWS access keys are stored in GitHub. The role ARN is configuration, not a credential.

The observed OIDC claims for the successful deployment include:

```text
iss = https://token.actions.githubusercontent.com
aud = sts.amazonaws.com
sub = repo:phatcobra@69565195/aws-operations-poc@1372530555:environment:production
ref = refs/heads/main
```

AWS trusts that exact subject. See [`docs/AWS_BOUNDARY.md`](docs/AWS_BOUNDARY.md) for the project-scoped trust and IAM boundary.

## Observability

Operational state is visible through five complementary signals:

- `aws-operations-poc-operations`, the CloudWatch operator dashboard;
- structured CloudWatch Logs for run-level events and failure context;
- native Lambda CloudWatch metrics for invocation, duration, throttling, and platform-level errors;
- `aws-operations-poc-heartbeat-stale` for schedule staleness detection;
- DynamoDB attempt records for durable success/failure/recovery history.

The deliberate application-level failures are handled inside the bounded recovery loop, so their authoritative outcome is the structured log/evidence contract rather than the Lambda `Errors` metric.

## Security model

- The application stack creates no IAM resources.
- Lambda uses a pre-provisioned runtime role.
- CloudFormation uses a pre-provisioned service role.
- GitHub uses short-lived OIDC credentials, not long-lived AWS keys.
- The GitHub deployment role is scoped to this project's stack and exact live-proof resources.
- The CloudFormation role has project-scoped authority for the heartbeat alarm and operator dashboard.
- The `production` GitHub environment is restricted to `main`.
- The public weather API requires no secret or API key.

## Cost controls

- Lambda: 128 MB, hourly schedule, 20-second timeout ceiling.
- DynamoDB: `PAY_PER_REQUEST`.
- CloudWatch Logs: 14-day retention.
- Heartbeat uses the native Lambda invocation metric, so it does not create a custom metric.
- Dashboard widgets reuse native metrics and existing logs; no always-on UI compute is introduced.
- The public dashboard is static GitHub Pages output; its status snapshot is generated by the publish workflow.
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

Live acceptance proof:

```bash
python3 scripts/verify_live.py --output live-evidence.json
```

## Repository layout

```text
src/                  Lambda workload
tests/                deterministic offline tests
infra/                CloudFormation
.github/workflows/     CI and CD
scripts/              render, deploy, manual/live verification
site/                 public Hourly Helper page and fallback status contract
docs/                 security boundary and portfolio explanation
```

For an interview-oriented explanation and resume wording, see [`docs/PORTFOLIO.md`](docs/PORTFOLIO.md).
