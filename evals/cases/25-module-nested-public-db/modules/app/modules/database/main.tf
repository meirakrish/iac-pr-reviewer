variable "name" { type = string }
variable "public" { type = bool }

resource "aws_db_instance" "this" {
  identifier          = var.name
  engine              = "postgres"
  engine_version      = "16.3"
  instance_class      = "db.t4g.medium"
  allocated_storage   = 50
  username            = "app"
  password            = "Nested-Secret-456!"
  storage_encrypted   = true
  publicly_accessible = var.public
  skip_final_snapshot = false
  tags                = { Team = "data", Environment = "prod" }
}

resource "aws_security_group" "db" {
  name        = "${var.name}-sg"
  description = "Postgres access"
  vpc_id      = "vpc-0abc123def4567890"

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.public ? "0.0.0.0/0" : "10.0.0.0/16"]
  }

  tags = { Team = "data", Environment = "prod" }
}
