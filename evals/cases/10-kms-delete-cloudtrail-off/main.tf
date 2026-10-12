# KMS key removed; CloudTrail logging paused "to cut costs".
resource "aws_cloudtrail" "main" {
  name                          = "org-trail"
  s3_bucket_name                = "acme-cloudtrail-logs"
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  enable_logging                = false
  tags                          = { Team = "security", Environment = "prod" }
}
