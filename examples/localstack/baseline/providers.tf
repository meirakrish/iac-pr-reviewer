terraform {
  required_providers {
    # 5.x on purpose: provider 6.x waits for a DynamoDB "warm throughput" status that LocalStack 4.9 never
    # reports, so creating a table hangs until the 30-minute timeout. The review reads plan JSON, which is the same.
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

# All AWS calls go to LocalStack running in Docker.
provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true

  endpoints {
    dynamodb = "http://localhost:4566"
    ec2      = "http://localhost:4566"
    iam      = "http://localhost:4566"
    kms      = "http://localhost:4566"
    logs     = "http://localhost:4566"
    s3       = "http://localhost:4566"
    sqs      = "http://localhost:4566"
    sts      = "http://localhost:4566"
  }

  default_tags {
    tags = { Project = "orders", ManagedBy = "terraform" }
  }
}
