resource "azurerm_role_assignment" "ci_owner" {
  scope                = "/subscriptions/00000000-0000-0000-0000-000000000000"
  role_definition_name = "Owner"
  principal_id         = "22222222-2222-2222-2222-222222222222"
  principal_type       = "ServicePrincipal"
  description          = "CI pipeline needs to create role assignments"
}
