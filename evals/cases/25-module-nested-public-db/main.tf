module "analytics" {
  source      = "./modules/app"
  name        = "analytics"
  db_public   = true # "temporary, so the BI vendor can connect"
}
