# One-time human-admin bootstrap for aws-operations-poc only.
#
# Prerequisites:
#   - AWS CLI profile alex-admin-cli authenticated as IAM user alex-admin
#   - GitHub CLI authenticated to phatcobra
#
# This script addresses exact project resources only. It does not enumerate
# unrelated roles/resources and it creates no long-lived credentials.

$ErrorActionPreference = "Continue"

$Profile = "alex-admin-cli"
$Region = "us-east-2"
$Account = "660838763909"
$Repo = "phatcobra/aws-operations-poc"

$GitHubRole = "aws-operations-poc-github-deploy-role"
$GitHubRoleArn = "arn:aws:iam::${Account}:role/${GitHubRole}"
$CfnRole = "aws-operations-poc-cfn-role"
$CfnRoleArn = "arn:aws:iam::${Account}:role/${CfnRole}"
$ProviderArn = "arn:aws:iam::${Account}:oidc-provider/token.actions.githubusercontent.com"
$Subject = "repo:phatcobra@69565195/aws-operations-poc@1372530555:environment:production"
$StackArn = "arn:aws:cloudformation:${Region}:${Account}:stack/aws-operations-poc-*/*"

$Tmp = Join-Path $env:TEMP "aws-operations-poc-admin-bootstrap"
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

function Fail([string]$Message) {
    throw "STOP: $Message"
}

function Assert-Success([string]$Label) {
    if ($LASTEXITCODE -ne 0) {
        Fail "$Label failed (exit $LASTEXITCODE)."
    }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText(
        $Path,
        $Text,
        (New-Object System.Text.UTF8Encoding($false))
    )
}

try {
    Write-Host "=== aws-operations-poc admin bootstrap ==="

    # 1. Verify the exact human administrator identity.
    $WhoRaw = & aws sts get-caller-identity --profile $Profile --region $Region --output json 2>&1
    Assert-Success "AWS identity verification"
    $Who = ($WhoRaw | Out-String | ConvertFrom-Json)
    $ExpectedArn = "arn:aws:iam::${Account}:user/alex-admin"
    if ($Who.Arn -ne $ExpectedArn) {
        Fail "Expected $ExpectedArn but got $($Who.Arn). Re-authenticate alex-admin-cli first."
    }
    Write-Host "PASS: alex-admin verified"

    # 2. Ensure the exact GitHub OIDC provider exists and accepts STS audience.
    $ProviderRaw = & aws iam get-open-id-connect-provider `
        --open-id-connect-provider-arn $ProviderArn `
        --profile $Profile --output json 2>$null
    $ProviderExists = ($LASTEXITCODE -eq 0)

    if (-not $ProviderExists) {
        & aws iam create-open-id-connect-provider `
            --url "https://token.actions.githubusercontent.com" `
            --client-id-list "sts.amazonaws.com" `
            --profile $Profile --output json | Out-Null
        Assert-Success "OIDC provider creation"
    }
    else {
        $Provider = ($ProviderRaw | Out-String | ConvertFrom-Json)
        if (@($Provider.ClientIDList) -notcontains "sts.amazonaws.com") {
            & aws iam add-client-id-to-open-id-connect-provider `
                --open-id-connect-provider-arn $ProviderArn `
                --client-id "sts.amazonaws.com" `
                --profile $Profile
            Assert-Success "OIDC audience update"
        }
    }
    Write-Host "PASS: GitHub OIDC provider ready"

    # 3. Create/update the GitHub deployment role with the empirically observed
    #    production-environment subject from GitHub Actions.
    $TrustPath = Join-Path $Tmp "github-trust.json"
    $Trust = @{
        Version = "2012-10-17"
        Statement = @(
            @{
                Effect = "Allow"
                Principal = @{ Federated = $ProviderArn }
                Action = "sts:AssumeRoleWithWebIdentity"
                Condition = @{
                    StringEquals = @{
                        "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
                        "token.actions.githubusercontent.com:sub" = $Subject
                    }
                }
            }
        )
    } | ConvertTo-Json -Depth 20
    Write-Utf8NoBom $TrustPath $Trust

    & aws iam get-role --role-name $GitHubRole --profile $Profile --output json 1>$null 2>$null
    $RoleExists = ($LASTEXITCODE -eq 0)

    if ($RoleExists) {
        & aws iam update-assume-role-policy `
            --role-name $GitHubRole `
            --policy-document "file://$TrustPath" `
            --profile $Profile
        Assert-Success "GitHub role trust update"
    }
    else {
        & aws iam create-role `
            --role-name $GitHubRole `
            --assume-role-policy-document "file://$TrustPath" `
            --description "OIDC deployment and live proof for aws-operations-poc" `
            --tags Key=Project,Value=aws-operations-poc `
            --profile $Profile --output json | Out-Null
        Assert-Success "GitHub role creation"
    }
    Write-Host "PASS: GitHub role trust ready"

    # 4. Give that role only stack deployment + exact runtime-proof authority.
    $DeployPolicyPath = Join-Path $Tmp "github-deploy-policy.json"
    $DeployPolicy = @{
        Version = "2012-10-17"
        Statement = @(
            @{
                Sid = "PocStackMutation"
                Effect = "Allow"
                Action = @(
                    "cloudformation:CreateStack",
                    "cloudformation:UpdateStack",
                    "cloudformation:DeleteStack"
                )
                Resource = $StackArn
                Condition = @{
                    StringEquals = @{ "cloudformation:RoleArn" = $CfnRoleArn }
                }
            },
            @{
                Sid = "PocStackRead"
                Effect = "Allow"
                Action = @(
                    "cloudformation:DescribeStacks",
                    "cloudformation:GetTemplate"
                )
                Resource = $StackArn
            },
            @{
                Sid = "ValidateTemplate"
                Effect = "Allow"
                Action = "cloudformation:ValidateTemplate"
                Resource = "*"
            },
            @{
                Sid = "PassOnlyPocCfnRole"
                Effect = "Allow"
                Action = "iam:PassRole"
                Resource = $CfnRoleArn
                Condition = @{
                    StringEquals = @{ "iam:PassedToService" = "cloudformation.amazonaws.com" }
                }
            },
            @{
                Sid = "InvokeProofFunction"
                Effect = "Allow"
                Action = "lambda:InvokeFunction"
                Resource = "arn:aws:lambda:${Region}:${Account}:function:aws-operations-poc-worker"
            },
            @{
                Sid = "ReadProofEvidence"
                Effect = "Allow"
                Action = "dynamodb:Query"
                Resource = "arn:aws:dynamodb:${Region}:${Account}:table/aws-operations-poc-runs"
            },
            @{
                Sid = "ReadProofLogs"
                Effect = "Allow"
                Action = "logs:FilterLogEvents"
                Resource = "arn:aws:logs:${Region}:${Account}:log-group:/aws/lambda/aws-operations-poc-worker:*"
            }
        )
    } | ConvertTo-Json -Depth 20
    Write-Utf8NoBom $DeployPolicyPath $DeployPolicy

    & aws iam put-role-policy `
        --role-name $GitHubRole `
        --policy-name AwsOperationsPocGitHubDeployAndProof `
        --policy-document "file://$DeployPolicyPath" `
        --profile $Profile
    Assert-Success "GitHub role permissions"
    Write-Host "PASS: GitHub deployment/live-proof permissions ready"

    # 5. Extend only the existing POC CloudFormation service role so the stack
    #    can own one heartbeat/staleness alarm.
    & aws iam get-role --role-name $CfnRole --profile $Profile --output json 1>$null 2>$null
    Assert-Success "POC CloudFormation role lookup"

    $AlarmPolicyPath = Join-Path $Tmp "cfn-heartbeat-policy.json"
    $AlarmArn = "arn:aws:cloudwatch:${Region}:${Account}:alarm:aws-operations-poc-heartbeat-stale"
    $AlarmPolicy = @{
        Version = "2012-10-17"
        Statement = @(
            @{
                Sid = "ManagePocHeartbeatAlarm"
                Effect = "Allow"
                Action = @(
                    "cloudwatch:PutMetricAlarm",
                    "cloudwatch:DeleteAlarms",
                    "cloudwatch:DescribeAlarms"
                )
                Resource = $AlarmArn
            }
        )
    } | ConvertTo-Json -Depth 20
    Write-Utf8NoBom $AlarmPolicyPath $AlarmPolicy

    & aws iam put-role-policy `
        --role-name $CfnRole `
        --policy-name AwsOperationsPocHeartbeatAlarm `
        --policy-document "file://$AlarmPolicyPath" `
        --profile $Profile
    Assert-Success "CloudFormation heartbeat-alarm permissions"
    Write-Host "PASS: heartbeat alarm authority ready"

    # 6. Restrict the exact GitHub production environment to main.
    $EnvBody = '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
    $EnvBody | & gh api --method PUT "repos/$Repo/environments/production" --input - 1>$null
    Assert-Success "GitHub production environment update"

    $BranchNames = @(& gh api `
        "repos/$Repo/environments/production/deployment-branch-policies" `
        --jq '.branch_policies[].name' 2>$null)
    Assert-Success "GitHub deployment branch policy read"

    if ($BranchNames -notcontains "main") {
        & gh api --method POST `
            "repos/$Repo/environments/production/deployment-branch-policies" `
            -f name="main" -f type="branch" 1>$null
        Assert-Success "GitHub main-only deployment branch policy"
    }
    Write-Host "PASS: production environment restricted to main"

    Write-Host ""
    Write-Host "=============================================="
    Write-Host "BOOTSTRAP_COMPLETE"
    Write-Host "OIDC subject: $Subject"
    Write-Host "GitHub role:  $GitHubRoleArn"
    Write-Host "Region:       $Region"
    Write-Host "=============================================="
}
finally {
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
