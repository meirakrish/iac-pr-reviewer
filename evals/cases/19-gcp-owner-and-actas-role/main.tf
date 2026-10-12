resource "google_project_iam_member" "contractor_owner" {
  project = "acme-prod"
  role    = "roles/owner"
  member  = "user:contractor@example.com"
}

resource "google_project_iam_custom_role" "deployer" {
  role_id     = "deployer"
  title       = "Deployer"
  permissions = [
    "iam.serviceAccounts.actAs",
    "compute.instances.create",
    "compute.instances.setMetadata",
    "compute.disks.create",
    "compute.subnetworks.use",
  ]
}
