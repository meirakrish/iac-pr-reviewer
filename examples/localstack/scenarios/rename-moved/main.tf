module "network" {
  source = "./modules/network"
  name   = "orders-prod"
}

resource "aws_kms_key" "data" {
  description             = "Encrypts order data"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

module "orders_service" {
  source      = "./modules/orders"
  env         = "prod"
  kms_key_arn = aws_kms_key.data.arn
}

resource "aws_iam_role" "orders_api" {
  name = "orders-api"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "orders_api" {
  name = "orders-data"
  role = aws_iam_role.orders_api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
        Resource = module.orders_service.table_arn
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = module.orders_service.queue_arn
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "orders_api" {
  name              = "/aws/lambda/orders-api"
  retention_in_days = 30
}

moved {
  from = module.orders
  to   = module.orders_service
}
