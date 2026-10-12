resource "aws_s3_bucket" "logs" {
  bucket = "acme-app-logs"
  tags = {
    Team        = "platform"
    Environment = "prod"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/acme/api"
  retention_in_days = 30
  tags = {
    Team        = "platform"
    Environment = "prod"
  }
}
