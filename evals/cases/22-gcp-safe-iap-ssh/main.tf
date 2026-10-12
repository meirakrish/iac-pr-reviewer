resource "google_compute_firewall" "iap_ssh" {
  name    = "allow-ssh-from-iap"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # Google's Identity-Aware Proxy TCP forwarding range: SSH only through IAP, not the internet.
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["ssh"]
}

resource "google_storage_bucket" "artifacts" {
  name                        = "acme-build-artifacts"
  location                    = "US"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = { team = "platform", environment = "prod" }

  versioning {
    enabled = true
  }
}

resource "google_project_iam_member" "ci_artifacts" {
  project = "acme-prod"
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:ci@acme-prod.iam.gserviceaccount.com"
}
