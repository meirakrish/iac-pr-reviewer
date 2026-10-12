resource "azurerm_resource_group" "db" {
  name     = "rg-db-prod"
  location = "westeurope"
  tags     = { Team = "orders", Environment = "prod" }
}

resource "azurerm_mssql_server" "orders" {
  name                          = "sql-orders-prod"
  resource_group_name           = azurerm_resource_group.db.name
  location                      = azurerm_resource_group.db.location
  version                       = "12.0"
  administrator_login           = "sqladmin"
  administrator_login_password  = "Pr0d-Passw0rd-DoNotLeak!"
  minimum_tls_version           = "1.2"
  public_network_access_enabled = true
  tags                          = { Team = "orders", Environment = "prod" }
}

resource "azurerm_mssql_firewall_rule" "everyone" {
  name             = "allow-all"
  server_id        = azurerm_mssql_server.orders.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "255.255.255.255"
}
