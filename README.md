# iac-pr-reviewer

LLM-powered review of Terraform plans. Flags risky infrastructure changes (destroys, replacements, IAM wildcards, internet exposure, public buckets, unencrypted storage, missing tags) before they're merged, and explains them in plain English.

> **Status:** the review pipeline and local CLI are done. The GitHub Action wrapper (PR comment, fail threshold in CI) is next.

## How it works

```
terraform show -json ─▶ load & trim ─▶ deterministic prechecks ─▶ LLM review ─▶ merge ─▶ markdown / JSON
                         (redacts sensitive values)               (zod-structured)  (LLM can add/raise, never remove/downgrade)
```

1. **Prechecks** (no LLM, `src/prechecks/`): resource destroy/replace (critical for stateful resources), IAM `*` actions/resources and public trust policies, `0.0.0.0/0` / `::/0` ingress, public S3 ACLs/policies/public-access-block, unencrypted RDS/EBS/EFS/etc., missing tags.
2. **LLM step** (`src/llm/`): gets only the changed resources (diffs for updates, sensitive values replaced with `(sensitive)`) plus the precheck findings, and returns `{ riskLevel, summary, findings[] }` validated against a zod schema (`src/schema.ts`).
3. **Merge** (`src/report/merge.ts`): precheck findings always survive; the LLM can add context, add findings and raise severity. LLM findings about resources not in the plan, or destroy/replace claims about resources that are only being created, are dropped. If the LLM call fails, the review still completes with prechecks only.

## CLI

Requires Node ≥ 20.

```bash
npm install
terraform plan -out plan.tfplan && terraform show -json plan.tfplan > plan.json
npm run iac-review -- --plan plan.json
```

| Flag | Env var | Default | |
|---|---|---|---|
| `--plan <file>` | | (required) | plan JSON, or `-` for stdin |
| `--format md\|json` | | `md` | markdown is the PR-comment body |
| `--out <file>` | | stdout | |
| `--fail-on <level>` | `IAC_REVIEW_FAIL_ON` | `none` | exit code 2 when risk ≥ level |
| `--provider` | `IAC_REVIEW_PROVIDER` | auto | `anthropic` if `ANTHROPIC_API_KEY` is set, else `openai` if `OPENAI_API_KEY`, else `ollama` |
| `--model` | `IAC_REVIEW_MODEL` | per provider | `qwen2.5:7b-instruct` / `claude-sonnet-5-5` / `gpt-5-mini` |
| `--no-llm` | `IAC_REVIEW_NO_LLM` | | prechecks only |
| `--required-tags a,b` | `IAC_REVIEW_REQUIRED_TAGS` | | without it, only resources with no tags at all are flagged |
| | `OLLAMA_HOST` | `http://localhost:11434` | |
| | `IAC_REVIEW_NUM_CTX` | `16384` | Ollama context window |
| | `IAC_REVIEW_MAX_PLAN_CHARS` | `40000` | plan excerpt budget sent to the LLM |
| | `IAC_REVIEW_TIMEOUT_MS` | `180000` | |

Exit codes: `0` ok, `1` error, `2` risk at or above `--fail-on`.

## Evals

`evals/cases/*/` holds 11 scenarios (safe and risky). Each has `main.tf`, an optional hand-written `terraform.tfstate` (to produce real updates/destroys/replacements), the generated `plan.json`, and `expected.json` with the expected risk range and findings.

```bash
npm run eval                                   # default provider/model
npm run eval -- --model qwen2.5-coder:7b       # compare models
npm run eval -- --provider anthropic --case 09 # single case
./evals/generate-plans.sh                      # regenerate plan.json files (needs terraform; runs offline with mock AWS creds)
```

The scorer reports risk-level accuracy, finding recall/precision (matched by resource + category group, with a minimum severity), and recall on "LLM-only" findings that rules can't catch, side by side with a prechecks-only baseline. Results are saved to `evals/results/` (git-ignored).

> `07-rds-public-unencrypted` intentionally contains a fake plaintext password to verify that sensitive values never reach the LLM prompt.

## Development

```bash
npm test          # vitest
npm run typecheck
```

`scripts/install-terraform.sh` installs Terraform on Ubuntu/WSL.
