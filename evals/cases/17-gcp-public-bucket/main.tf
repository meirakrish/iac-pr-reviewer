resource "google_storage_bucket" "invoices" {
  name                        = "acme-invoices-prod"
  location                    = "EU"
  uniform_bucket_level_access = true
  labels                      = { team = "billing", environment = "prod" }
}

resource "google_storage_bucket_iam_member" "public_read" {
  bucket = google_storage_bucket.invoices.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}
