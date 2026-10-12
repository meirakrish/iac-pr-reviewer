#!/usr/bin/env bash
# Try iac-pr-reviewer against real (emulated) AWS infrastructure in Docker, with no AWS account.
#
#   ./demo.sh up                 start LocalStack and deploy the baseline stack (14 resources)
#   ./demo.sh review <scenario>  plan a "pull request" against the deployed stack and review it
#   ./demo.sh all                up + review every scenario
#   ./demo.sh down               stop LocalStack and delete the working copy
#
# Scenarios live in scenarios/<name>/ and contain only the files that PR changes; they are copied over a
# fresh copy of baseline/ each time. Options (LLM provider, --no-llm, ...) go through IAC_REVIEW_* env vars.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
WORK="$HERE/.work"
CONTAINER=iac-localstack
# 4.9 is the last LocalStack image that runs without an account token. Eager loading avoids a deadlock in 4.9
# when Terraform creates EC2 and IAM resources in parallel and both services load at the same moment.
IMAGE=localstack/localstack:4.9
SERVICES=dynamodb,ec2,iam,kms,logs,s3,sqs,sts
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

log() { printf '\033[1m==> %s\033[0m\n' "$*"; }

localstack_ready() {
  curl -s localhost:4566/_localstack/health 2>/dev/null | grep -q '"ec2": "running"'
}

start_localstack() {
  if localstack_ready; then
    log "LocalStack already running"
    return
  fi
  log "Starting LocalStack ($IMAGE)"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -p 127.0.0.1:4566:4566 \
    -e EAGER_SERVICE_LOADING=1 -e SERVICES="$SERVICES" "$IMAGE" >/dev/null
  for _ in $(seq 90); do
    localstack_ready && return
    sleep 2
  done
  echo "LocalStack did not become ready; see: docker logs $CONTAINER" >&2
  exit 1
}

# Reset the working copy's config to baseline (+ a scenario), keeping Terraform state and providers.
use_config() {
  mkdir -p "$WORK"
  rm -rf "$WORK"/*.tf "$WORK/modules"
  cp -r "$HERE/baseline/." "$WORK/"
  if [[ -n "${1:-}" ]]; then cp -r "$HERE/scenarios/$1/." "$WORK/"; fi
  terraform -chdir="$WORK" init -input=false -no-color >/dev/null
}

cmd_up() {
  start_localstack
  if [[ -f "$WORK/terraform.tfstate" ]] && terraform -chdir="$WORK" state list 2>/dev/null | grep -q .; then
    log "Baseline already deployed"
    return
  fi
  log "Deploying the baseline stack to LocalStack"
  use_config
  terraform -chdir="$WORK" apply -auto-approve -input=false -no-color | grep -E "Creation complete|Apply complete|Error" |
    sed -E 's/ \[id=[^]]*\]//'
}

cmd_review() {
  local scenario=${1:?usage: demo.sh review <scenario>}
  [[ -d "$HERE/scenarios/$scenario" ]] || {
    echo "unknown scenario '$scenario'; available: $(ls "$HERE/scenarios" | tr '\n' ' ')" >&2
    exit 1
  }
  localstack_ready || {
    echo "LocalStack isn't running; run: ./demo.sh up" >&2
    exit 1
  }
  [[ -f "$REPO/dist/cli.js" ]] || (cd "$REPO" && npm run build >/dev/null)

  log "Scenario: $scenario"
  use_config "$scenario"
  terraform -chdir="$WORK" plan -input=false -no-color -out "$scenario.tfplan" >"$WORK/$scenario.plan.log"
  echo "terraform: $(grep -E '^Plan:|^No changes' "$WORK/$scenario.plan.log")"
  terraform -chdir="$WORK" show -json "$scenario.tfplan" >"$WORK/$scenario.json"
  # Exit code 2 (risk at or above IAC_REVIEW_FAIL_ON) is a result, not an error.
  node "$REPO/dist/cli.js" --plan "$WORK/$scenario.json" --out "$WORK/$scenario.md" || [[ $? -eq 2 ]]
  echo
  cat "$WORK/$scenario.md"
  echo
}

cmd_down() {
  log "Stopping LocalStack and removing the working copy"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}

case "${1:-}" in
  up) cmd_up ;;
  review) cmd_review "${2:-}" ;;
  all)
    cmd_up
    for s in safe risky rename rename-moved; do cmd_review "$s"; done
    ;;
  down) cmd_down ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
