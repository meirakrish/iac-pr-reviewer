resource "aws_security_group" "alb" {
  name        = "public-alb"
  description = "Public load balancer"
  vpc_id      = "vpc-0abc123def4567890"

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP (redirects to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  tags = { Team = "web", Environment = "prod" }
}

resource "aws_lb" "public" {
  name               = "public-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = ["subnet-0123456789abcdef0", "subnet-0fedcba9876543210"]
  drop_invalid_header_fields = true
  tags               = { Team = "web", Environment = "prod" }
}
