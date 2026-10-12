variable "name" { type = string }
variable "db_public" {
  type    = bool
  default = false
}

module "database" {
  source = "./modules/database"
  name   = "${var.name}-db"
  public = var.db_public
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/acme/${var.name}"
  retention_in_days = 30
  tags              = { Team = "data", Environment = "prod" }
}
