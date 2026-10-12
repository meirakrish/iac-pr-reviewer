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
]);

export const destroyCheck: Precheck = (rc) => {
  const kind = changeKind(rc.change.actions);
  const stateful = STATEFUL.has(rc.type);

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
          ? "Avoid the replacement (revert the forcing attribute or use `moved`/import), or migrate data explicitly."
          : "Check whether the forcing attribute change is necessary; consider `create_before_destroy`.",
      }),
    ];
  }

  return [];
};
