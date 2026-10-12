resource "aws_iam_role" "thumbnailer" {
  name = "thumbnailer-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Team = "media", Environment = "prod" }
}

resource "aws_iam_role_policy" "thumbnailer_logs" {
  name = "logs"
  role = aws_iam_role.thumbnailer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/thumbnailer:*"
    }, {
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "arn:aws:s3:::acme-media/thumbnails/*"
    }]
  })
}

resource "aws_cloudwatch_log_group" "thumbnailer" {
  name              = "/aws/lambda/thumbnailer"
  retention_in_days = 14
  tags              = { Team = "media", Environment = "prod" }
}
