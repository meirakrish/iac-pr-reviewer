variable "env" { type = string }
variable "kms_key_arn" { type = string }

resource "aws_dynamodb_table" "orders" {
  name         = "orders-${var.env}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "order_id"

  attribute {
    name = "order_id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_sqs_queue" "events_dlq" {
  name = "order-events-dlq-${var.env}"
}

resource "aws_sqs_queue" "events" {
  name = "order-events-${var.env}"
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.events_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_s3_bucket" "archive" {
  bucket = "acme-orders-archive-${var.env}"
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "table_arn" { value = aws_dynamodb_table.orders.arn }
output "queue_arn" { value = aws_sqs_queue.events.arn }
