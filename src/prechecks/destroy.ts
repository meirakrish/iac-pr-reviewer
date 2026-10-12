import { changeKind } from "../plan/types.js";
import { finding, type Precheck } from "./util.js";

/** Resources that hold data or identity which cannot be recreated by re-applying. */
const STATEFUL = new Set([
  "aws_db_instance",
  "aws_rds_cluster",
  "aws_rds_cluster_instance",
  "aws_dynamodb_table",
  "aws_s3_bucket",
  "aws_ebs_volume",
  "aws_efs_file_system",
  "aws_elasticache_cluster",
  "aws_elasticache_replication_group",
  "aws_redshift_cluster",
  "aws_docdb_cluster",
  "aws_neptune_cluster",
  "aws_opensearch_domain",
  "aws_elasticsearch_domain",
  "aws_kms_key",
  "aws_secretsmanager_secret",
  "aws_route53_zone",
  "aws_kinesis_stream",
  "aws_sqs_queue",
  "aws_msk_cluster",
  "aws_backup_vault",
  "aws_cognito_user_pool",
  "aws_ecr_repository",
  // Azure
  "azurerm_resource_group", // deleting it deletes everything inside
  "azurerm_storage_account",
  "azurerm_storage_container",
  "azurerm_storage_share",
  "azurerm_mssql_server",
  "azurerm_mssql_database",
  "azurerm_postgresql_flexible_server",
  "azurerm_mysql_flexible_server",
  "azurerm_cosmosdb_account",
  "azurerm_redis_cache",
  "azurerm_key_vault",
  "azurerm_key_vault_key",
  "azurerm_managed_disk",
  "azurerm_dns_zone",
  "azurerm_container_registry",
  "azurerm_recovery_services_vault",
  "azurerm_log_analytics_workspace",
  "azurerm_servicebus_namespace",
  "azurerm_eventhub_namespace",
  // GCP
  "google_project", // deleting it deletes everything inside
  "google_sql_database_instance",
  "google_sql_database",
  "google_storage_bucket",
  "google_compute_disk",
  "google_bigquery_dataset",
  "google_bigquery_table",
  "google_spanner_instance",
  "google_spanner_database",
  "google_bigtable_instance",
  "google_firestore_database",
  "google_redis_instance",
  "google_filestore_instance",
  "google_kms_crypto_key",
  "google_kms_key_ring",
  "google_secret_manager_secret",
  "google_dns_managed_zone",
  "google_pubsub_topic",
  "google_artifact_registry_repository",
]);

export const destroyCheck: Precheck = (rc, ctx) => {
  const kind = changeKind(rc.change.actions);
  const stateful = STATEFUL.has(rc.type);

  const move = kind === "delete" ? ctx.moves?.get(rc.address) : undefined;
  if (move) {
    const wholeModule = move.movedFrom !== rc.address;
    return [
      finding(rc, "missing-moved-block", {
        severity: stateful ? "critical" : "high",
        category: stateful ? "data-loss" : "destroy",
        issue:
          `Looks like a rename: this ${rc.type} is destroyed and recreated as ${move.to}` +
          (move.via === "identity" ? " (same name/identifier)" : "") +
          `. Without a \`moved\` block, Terraform deletes ${wholeModule ? `everything in ${move.movedFrom}` : "the existing resource"} instead of renaming it.`,
        blastRadius: stateful
          ? "The existing resource and its data are deleted and an empty one is created in its place."
          : "Downtime between destroy and create; anything referencing it gets a new ID.",
        suggestion: `Add a \`moved\` block with \`from = ${move.movedFrom}\` and \`to = ${move.movedTo}\`, then re-run the plan: it should show no destroy.`,
      }),
    ];
  }

  if (kind === "delete") {
    return [
      finding(rc, "resource-destroy", {
        severity: stateful ? "critical" : "high",
        category: stateful ? "data-loss" : "destroy",
        issue: stateful
          ? `Stateful resource ${rc.type} will be destroyed; its data cannot be recovered by re-applying.`
          : `${rc.type} will be destroyed.`,
        blastRadius: stateful
          ? "Permanent data loss plus outage for anything reading from or writing to it."
          : "Anything depending on this resource stops working after apply.",
        suggestion: stateful
          ? "Confirm the deletion is intended, take a backup/snapshot first, and consider `lifecycle { prevent_destroy = true }`."
          : "Confirm the removal is intended and nothing still references it.",
      }),
    ];
  }

  if (kind === "replace") {
    const paths = (rc.change.replace_paths ?? []).map((p) => (Array.isArray(p) ? p.join(".") : String(p)));
    const why = paths.length ? ` because ${paths.join(", ")} changed` : "";
    const createFirst = rc.change.actions[0] === "create";
    return [
      finding(rc, "resource-replace", {
        severity: stateful ? "critical" : createFirst ? "medium" : "high",
        category: stateful ? "data-loss" : "replace",
        issue: `${rc.type} will be destroyed and recreated${why}${createFirst ? " (create_before_destroy)" : ""}.`,
        blastRadius: stateful
          ? "The existing resource and its data are deleted; the new one starts empty."
          : createFirst
            ? "Brief overlap of old and new resource; dependents may see a new ID/ARN."
            : "Downtime between destroy and create; dependents get a new ID/ARN.",
        suggestion: stateful
          ? `Revert the change${paths.length ? ` to ${paths.join(", ")}` : ""} if possible. Otherwise plan a data migration: create the new resource alongside the old one, copy the data, then switch over.`
          : "Check whether the forcing attribute change is necessary; consider `create_before_destroy`.",
      }),
    ];
  }

  return [];
};
