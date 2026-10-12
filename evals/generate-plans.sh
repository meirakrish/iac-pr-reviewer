#!/usr/bin/env bash
# Regenerate evals/cases/*/plan.json with real `terraform plan` + `terraform show -json`.
# Each case has main.tf and optionally terraform.tfstate (to produce updates/destroys/replacements).
set -euo pipefail
cd "$(dirname "$0")"
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

for dir in cases/*/; do
  name=$(basename "$dir")
  work=$(mktemp -d)
  cp provider.tf "$dir"main.tf "$work"/
  [[ -f "$dir"terraform.tfstate ]] && cp "$dir"terraform.tfstate "$work"/
  (
    cd "$work"
    terraform init -input=false -no-color >/dev/null
    terraform plan -input=false -no-color -refresh=false -lock=false -out=plan.tfplan >/dev/null
    terraform show -json plan.tfplan
  ) > "$dir"plan.json
  rm -rf "$work"
  echo "✓ $name"
done
