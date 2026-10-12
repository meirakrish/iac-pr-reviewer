# A fake access token is enough for `terraform plan -refresh=false` on new resources.
provider "google" {
  project      = "acme-prod"
  region       = "us-central1"
  access_token = "mock"
}
