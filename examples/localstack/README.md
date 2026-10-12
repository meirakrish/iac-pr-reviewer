# Try it with Docker (LocalStack)

This demo runs iac-pr-reviewer against **real deployed infrastructure** without an AWS account. [LocalStack](https://www.localstack.cloud/) emulates AWS in a Docker container: Terraform deploys a stack to it, then each "pull request" scenario is planned against that live state and reviewed.

Because the plans come from real state, they include everything a real PR would: refreshed values, in-place updates, forced replacements and module renames.

## Run it

Needs Docker, Terraform, Node.js 20.11+ and (for the AI part) Ollama with `qwen3.5:9b`. From this folder:

```bash
./demo.sh all
```

This starts LocalStack, deploys the baseline, and reviews every scenario (about 2 minutes). Or step by step:

```bash
./demo.sh up
```

```bash
./demo.sh review risky
```

```bash
./demo.sh down
```

Reports are saved in `.work/<scenario>.md`, next to the plan JSON. To run without an LLM, prefix any command with `IAC_REVIEW_NO_LLM=1`.

## What's deployed

`baseline/` is a small but realistic stack (14 resources):

- `module.network`: VPC, subnet, security group allowing HTTPS from inside the VPC
- `module.orders`: DynamoDB table with point-in-time recovery, SQS queue with a dead-letter queue, an S3 archive bucket with versioning, KMS encryption and a public access block
- a KMS key with rotation, an IAM role for the API scoped to the table and queue, a log group

## Scenarios

Each folder in `scenarios/` holds only the files that "PR" changes. Diff it against `baseline/` to see exactly what changed.

| Scenario | Change | Expected review |
|---|---|---|
| `safe` | new notifications queue, log retention 30 → 90 days, an owner tag | 🟢 LOW, no findings |
| `risky` | SSH open to `0.0.0.0/0` "for debugging", IAM `dynamodb:*` on `*`, public access block disabled, DynamoDB key renamed (forces replacement), point-in-time recovery off | 🔴 CRITICAL, 5 findings |
| `rename` | `module.orders` renamed to `module.orders_service` without a `moved` block | 🔴 CRITICAL, one finding with the exact `moved` fix |
| `rename-moved` | the same rename with a `moved` block | 🟢 LOW, "7 resources are only renamed" |

## Why these versions

- **LocalStack 4.9**: newer images require a LocalStack account token, even for free use. 4.9 runs without one. It is started with `EAGER_SERVICE_LOADING=1`: with lazy loading, Terraform creating EC2 and IAM resources in parallel triggers a deadlock inside LocalStack.
- **AWS provider 5.x**: provider 6.x waits for a DynamoDB status field that LocalStack 4.9 doesn't return, so creating a table hangs. Plan JSON is the same format either way.
