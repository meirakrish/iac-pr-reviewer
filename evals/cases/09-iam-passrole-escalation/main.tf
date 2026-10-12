resource "aws_iam_policy" "deployer" {
  name = "lambda-deployer"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "DeployFunctions"
      Effect   = "Allow"
      Action   = ["lambda:CreateFunction", "lambda:UpdateFunctionCode", "lambda:InvokeFunction", "iam:PassRole"]
      Resource = "*"
    }]
  })
  tags = { Team = "platform", Environment = "prod" }
}
