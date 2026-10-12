import type { Severity } from "../schema.js";
import { after, asArray, finding, type Precheck } from "./util.js";

/** resource type → [attribute that must be true, severity when it is not]. */
const ENCRYPTION_FLAGS: Record<string, [string, Severity]> = {
  aws_db_instance: ["storage_encrypted", "high"],
  aws_rds_cluster: ["storage_encrypted", "high"],
  aws_docdb_cluster: ["storage_encrypted", "high"],
  aws_neptune_cluster: ["storage_encrypted", "high"],
  aws_redshift_cluster: ["encrypted", "high"],
  aws_ebs_volume: ["encrypted", "medium"],
  aws_efs_file_system: ["encrypted", "medium"],
  aws_elasticache_replication_group: ["at_rest_encryption_enabled", "medium"],
};

export const encryptionCheck: Precheck = (rc) => {
  const a = after(rc);
  if (!a) return [];
  const unencrypted: string[] = [];
  let severity: Severity = "medium";

  const flag = ENCRYPTION_FLAGS[rc.type];
  // Unknown values are omitted from `after`, so only flag explicit false/null — not missing keys.
  if (flag && flag[0] in a && a[flag[0]] !== true) {
    unencrypted.push(flag[0]);
    severity = flag[1];
  }

  if (rc.type === "aws_instance") {
    for (const block of ["root_block_device", "ebs_block_device"]) {
      asArray<Record<string, unknown>>(a[block]).forEach((d, i) => {
        if (d && d.encrypted === false) unencrypted.push(`${block}[${i}].encrypted`);
      });
    }
  }

  if (rc.type === "aws_launch_template") {
    for (const m of asArray<Record<string, unknown>>(a.block_device_mappings)) {
      for (const ebs of asArray<Record<string, unknown>>(m?.ebs)) {
        if (ebs && (ebs.encrypted === false || ebs.encrypted === "false")) unencrypted.push(`block_device_mappings[${String(m.device_name)}].ebs.encrypted`);
      }
    }
  }

  if (!unencrypted.length) return [];
  return [
    finding(rc, "unencrypted-storage", {
      severity,
      category: "encryption",
      issue: `Storage is not encrypted at rest (${unencrypted.join(", ")}).`,
      blastRadius: "Data, snapshots and backups are stored in plaintext; this usually breaks compliance requirements (SOC 2, PCI, HIPAA).",
      suggestion: `Set ${unencrypted.map((u) => `${u} = true`).join(", ")}${rc.type.startsWith("aws_db") || rc.type.startsWith("aws_rds") ? " (note: enabling this on an existing database forces replacement)" : ""}.`,
    }),
  ];
};
