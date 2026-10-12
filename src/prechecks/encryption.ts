import { maxSeverity, type Severity } from "../schema.js";
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

  if (!unencrypted.length) return transitCheck(rc, a);
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

const WEAK_TLS = new Set(["TLS1_0", "TLS1_1", "1.0", "1.1", "Disabled"]);

/** Azure and GCP encrypt storage at rest by default, so for them the risk is unencrypted or weakly encrypted traffic. */
function transitCheck(rc: Parameters<Precheck>[0], a: Record<string, unknown>): ReturnType<Precheck> {
  const problems: { severity: Severity; text: string; fix: string }[] = [];

  if (rc.type === "azurerm_storage_account") {
    if (a.https_traffic_only_enabled === false) problems.push({ severity: "high", text: "plain HTTP is allowed (https_traffic_only_enabled = false)", fix: "https_traffic_only_enabled = true" });
    if (WEAK_TLS.has(String(a.min_tls_version))) problems.push({ severity: "medium", text: `minimum TLS version is ${a.min_tls_version}`, fix: 'min_tls_version = "TLS1_2"' });
  }
  if (rc.type === "azurerm_mssql_server" && WEAK_TLS.has(String(a.minimum_tls_version))) {
    problems.push({ severity: "medium", text: `minimum TLS version is ${a.minimum_tls_version}`, fix: 'minimum_tls_version = "1.2"' });
  }
  if (rc.type === "azurerm_redis_cache" && a.non_ssl_port_enabled === true) {
    problems.push({ severity: "medium", text: "the non-TLS port 6379 is enabled", fix: "non_ssl_port_enabled = false" });
  }
  if (rc.type === "google_sql_database_instance") {
    const ip = asArray<Record<string, unknown>>(asArray<Record<string, unknown>>(a.settings)[0]?.ip_configuration)[0];
    if (ip?.ssl_mode === "ALLOW_UNENCRYPTED_AND_ENCRYPTED") {
      problems.push({ severity: ip.ipv4_enabled === false ? "low" : "medium", text: "unencrypted connections are accepted (ssl_mode = ALLOW_UNENCRYPTED_AND_ENCRYPTED)", fix: 'ssl_mode = "ENCRYPTED_ONLY"' });
    }
  }

  if (!problems.length) return [];
  return [
    finding(rc, "unencrypted-transit", {
      severity: maxSeverity(problems.map((p) => p.severity)),
      category: "encryption",
      issue: `Traffic may not be encrypted in transit: ${problems.map((p) => p.text).join("; ")}.`,
      blastRadius: "Credentials and data can be read or modified by anyone on the network path.",
      suggestion: `Set ${problems.map((p) => p.fix).join(", ")}.`,
    }),
  ];
}
