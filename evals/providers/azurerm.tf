# Offline planning: authenticates through the fake `az` CLI (evals/mock/az) and talks to
# the fake Resource Manager (evals/mock/fake-arm.mjs) via metadata_host. No Azure account needed.
provider "azurerm" {
  features {}
  subscription_id                 = "00000000-0000-0000-0000-000000000000"
  tenant_id                       = "00000000-0000-0000-0000-000000000000"
  use_cli                         = true
  metadata_host                   = "localhost:18443"
  resource_provider_registrations = "none"
}
