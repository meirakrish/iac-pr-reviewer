resource "azurerm_resource_group" "data" {
  name     = "rg-data-prod"
  location = "westeurope"
  tags     = { Team = "data", Environment = "prod" }
}

resource "azurerm_storage_account" "reports" {
  name                            = "acmereportsprod"
  resource_group_name             = azurerm_resource_group.data.name
  location                        = azurerm_resource_group.data.location
  account_tier                    = "Standard"
  account_replication_type        = "GRS"
  https_traffic_only_enabled      = false
  min_tls_version                 = "TLS1_0"
  allow_nested_items_to_be_public = true
  tags                            = { Team = "data", Environment = "prod" }
}

resource "azurerm_storage_container" "exports" {
  name                  = "customer-exports"
  storage_account_id    = azurerm_storage_account.reports.id
  container_access_type = "container"
}
