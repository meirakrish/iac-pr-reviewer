#!/usr/bin/env bash
# Install Terraform on Ubuntu from HashiCorp's official apt repo.
# Uses the "noble" (24.04) suite, since HashiCorp may not publish newer Ubuntu codenames yet.
set -euo pipefail

sudo apt-get update
sudo apt-get install -y gnupg curl lsb-release

curl -fsSL https://apt.releases.hashicorp.com/gpg \
  | sudo gpg --dearmor --yes -o /usr/share/keyrings/hashicorp-archive-keyring.gpg

echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com noble main" \
  | sudo tee /etc/apt/sources.list.d/hashicorp.list

sudo apt-get update
sudo apt-get install -y terraform
terraform -version
