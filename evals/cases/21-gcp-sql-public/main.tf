resource "google_sql_database_instance" "analytics" {
  name                = "analytics-pg"
  database_version    = "POSTGRES_16"
  region              = "us-central1"
  deletion_protection = false

  settings {
    tier = "db-custom-2-7680"

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ALLOW_UNENCRYPTED_AND_ENCRYPTED"

      authorized_networks {
        name  = "anywhere"
        value = "0.0.0.0/0"
      }
    }

    backup_configuration {
      enabled = false
    }

    user_labels = { team = "data", environment = "prod" }
  }
}
