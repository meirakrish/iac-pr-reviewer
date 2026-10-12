resource "aws_instance" "api" {
  ami           = "ami-0f1e2d3c4b5a69788" # bumped base image
  instance_type = "t3.large"
  subnet_id     = "subnet-0123456789abcdef0"
  root_block_device {
    encrypted = true
  }
  tags = { Name = "api-1", Team = "orders", Environment = "prod" }
}
