# Refactor: module renamed for consistency, bucket resource renamed to match.
module "orders_database" {
  source   = "./modules/database"
  name     = "orders-prod"
  vpc_cidr = "10.0.0.0/16"
}

resource "aws_s3_bucket" "app_logs" {
  bucket = "acme-orders-logs"
  tags   = { Team = "orders", Environment = "prod" }
}
