# The billing database was removed from the config while moving to a new module.
resource "google_storage_bucket" "billing_exports" {
  name                        = "acme-billing-exports"
  location                    = "EU"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = { team = "billing", environment = "prod" }
}
