variable "name" { type = string }
variable "vpc_cidr" { type = string }

resource "aws_db_instance" "this" {
  identifier              = var.name
  engine                  = "postgres"
  engine_version          = "16.3"
  instance_class          = "db.r6g.large"
  allocated_storage       = 200
  username                = "app"
  password                = "Module-Secret-123!"
  storage_encrypted       = true
  backup_retention_period = 7
  deletion_protection     = false
  skip_final_snapshot     = true
  tags                    = { Team = "orders", Environment = "prod" }
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "Postgres from the VPC"
  vpc_id      = "vpc-0abc123def4567890"

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = { Team = "orders", Environment = "prod" }
}
