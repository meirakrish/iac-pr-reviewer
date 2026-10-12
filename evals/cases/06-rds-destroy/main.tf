# The orders database block was deleted from the config during a "cleanup" refactor.
resource "aws_cloudwatch_log_group" "orders_api" {
  name              = "/acme/orders-api"
  retention_in_days = 30
  tags              = { Team = "orders", Environment = "prod" }
}
