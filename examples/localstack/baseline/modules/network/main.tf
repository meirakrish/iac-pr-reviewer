variable "name" { type = string }

resource "aws_vpc" "this" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = var.name }
}

resource "aws_subnet" "app" {
  vpc_id     = aws_vpc.this.id
  cidr_block = "10.0.1.0/24"
  tags       = { Name = "${var.name}-app" }
}

resource "aws_security_group" "app" {
  name        = "${var.name}-app"
  description = "App servers"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS from inside the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.this.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

output "vpc_id" { value = aws_vpc.this.id }
output "sg_id" { value = aws_security_group.app.id }
