#!/usr/bin/env bash
# Regenerate evals/cases/*/plan.json with real `terraform plan` + `terraform show -json`.
# Runs fully offline with mock credentials: no AWS, Azure or GCP account needed.
#
#   ./evals/generate-plans.sh          # all cases
#   ./evals/generate-plans.sh 12 13    # only cases whose name contains "12" or "13"
#
# Each case has main.tf, optionally terraform.tfstate (to produce updates/destroys/replacements)
# and optionally a modules/ folder with local modules.
# Providers are picked from the resource types used in main.tf / terraform.tfstate.
set -euo pipefail
cd "$(dirname "$0")"
EVALS=$(pwd)
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

declare -A SOURCES=([aws]="hashicorp/aws|~> 6.0" [azurerm]="hashicorp/azurerm|~> 4.0" [google]="hashicorp/google|~> 7.0")

# Azure needs a fake CLI (auth) and a fake Resource Manager endpoint; started lazily.
ARM_PID=""
MOCK_DIR=""
cleanup() {
  if [[ -n "$ARM_PID" ]]; then kill "$ARM_PID" 2>/dev/null || true; fi
  if [[ -n "$MOCK_DIR" ]]; then rm -rf "$MOCK_DIR"; fi
}
trap cleanup EXIT

start_azure_mock() {
  [[ -n "$ARM_PID" ]] && return
  MOCK_DIR=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$MOCK_DIR/key.pem" -out "$MOCK_DIR/cert.pem" 2>/dev/null
  node "$EVALS/mock/fake-arm.mjs" "$MOCK_DIR/cert.pem" "$MOCK_DIR/key.pem" 18443 &
  ARM_PID=$!
  mkdir -p "$MOCK_DIR/bin" && cp "$EVALS/mock/az" "$MOCK_DIR/bin/az" && chmod +x "$MOCK_DIR/bin/az"
  for _ in $(seq 50); do curl -sk -o /dev/null https://localhost:18443/metadata/endpoints && return; sleep 0.1; done
  echo "fake ARM server did not start" >&2
  exit 1
}

matches_filter() {
  [[ $# -le 1 ]] && return 0
  local name=$1; shift
  for f in "$@"; do [[ "$name" == *"$f"* ]] && return 0; done
  return 1
}

for dir in cases/*/; do
  name=$(basename "$dir")
  matches_filter "$name" "$@" || continue

  work=$(mktemp -d)
  # Copy the whole case (main.tf, optional terraform.tfstate, local modules/), minus outputs.
  cp -r "$dir". "$work"/
  rm -f "$work"/plan.json "$work"/expected.json

  # Pick providers from resource type prefixes (including inside local modules), and write a matching required_providers
  # block.
  providers=()
  for p in aws azurerm google; do
    if grep -rqE "(resource \"${p}_|\"type\": *\"${p}_)" --include='*.tf' --include='*.tfstate' "$work" 2>/dev/null; then
      providers+=("$p")
      cp "providers/$p.tf" "$work/provider-$p.tf"
    fi
  done
  {
    echo "terraform {"
    echo "  required_providers {"
    for p in "${providers[@]}"; do
      IFS='|' read -r src ver <<<"${SOURCES[$p]}"
      echo "    $p = { source = \"$src\", version = \"$ver\" }"
    done
    echo "  }"
    echo "}"
  } >"$work/versions.tf"

  env_extra=()
  if [[ " ${providers[*]} " == *" azurerm "* ]]; then
    start_azure_mock
    env_extra=(PATH="$MOCK_DIR/bin:$PATH" SSL_CERT_FILE="$MOCK_DIR/cert.pem")
  fi

  (
    cd "$work"
    env "${env_extra[@]}" terraform init -input=false -no-color >/dev/null
    env "${env_extra[@]}" terraform plan -input=false -no-color -refresh=false -lock=false -out=plan.tfplan >/dev/null
    env "${env_extra[@]}" terraform show -json plan.tfplan
  ) >"$dir"plan.json
  rm -rf "$work"
  echo "✓ $name (${providers[*]})"
done
