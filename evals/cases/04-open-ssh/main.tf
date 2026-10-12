resource "aws_security_group" "bastion" {
  name        = "bastion"
  description = "Bastion host"
  vpc_id      = "vpc-0abc123def4567890"

  ingress {
    description = "SSH from anywhere (debugging)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Team = "platform", Environment = "prod" }
}
