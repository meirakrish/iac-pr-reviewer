resource "aws_db_instance" "analytics" {
  identifier              = "analytics"
  engine                  = "postgres"
  engine_version          = "16.3"
  instance_class          = "db.t4g.medium"
  allocated_storage       = 50
  db_name                 = "analytics"
  username                = "analytics"
  password                = "Sup3rS3cret-DoNotLeak!"
  publicly_accessible     = true
  storage_encrypted       = false
  skip_final_snapshot     = true
  deletion_protection     = false
  backup_retention_period = 0
  tags                    = { Team = "data", Environment = "prod" }
}
