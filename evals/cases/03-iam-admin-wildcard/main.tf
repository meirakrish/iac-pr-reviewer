resource "aws_iam_role" "ci" {
  name = "github-ci-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike   = { "token.actions.githubusercontent.com:sub" = "repo:acme/infra:*" }
      }
    }]
  })
  tags = { Team = "platform" }
}

resource "aws_iam_policy" "ci_deploy" {
  name        = "ci-deploy"
  description = "Temporary: unblock deploys"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "DoEverything", Effect = "Allow", Action = "*", Resource = "*" }]
  })
  tags = { Team = "platform" }
}

resource "aws_iam_role_policy_attachment" "ci_deploy" {
  role       = aws_iam_role.ci.name
  policy_arn = aws_iam_policy.ci_deploy.arn
}
