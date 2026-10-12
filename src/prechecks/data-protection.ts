import { maxSeverity, type Severity } from "../schema.js";
import { changeKind } from "../plan/types.js";
import { asArray, finding, type Precheck } from "./util.js";

type Values = Record<string, unknown>;

interface Protection {
  /** What the setting protects against, e.g. "point-in-time recovery". */
  label: string;
  severity: Severity;
  /** Whether the protection is on, given a resource's attributes; null when the plan doesn't say. */
  isOn: (v: Values) => boolean | null;
  /** Setting to restore it, shown in the suggestion. */
  fix: string;
}

const first = (v: unknown): Values => (asArray<Values>(v)[0] ?? {}) as Values;
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

const PROTECTIONS: Record<string, Protection[]> = {
  aws_dynamodb_table: [
    {
      label: "point-in-time recovery",
      severity: "high",
      isOn: (v) => bool(first(v.point_in_time_recovery).enabled),
      fix: "point_in_time_recovery { enabled = true }",
    },
    {
      label: "deletion protection",
      severity: "medium",
      isOn: (v) => bool(v.deletion_protection_enabled),
      fix: "deletion_protection_enabled = true",
    },
  ],
  aws_s3_bucket_versioning: [
    {
      label: "versioning",
      severity: "high",
      isOn: (v) => {
        const status = first(v.versioning_configuration).status;
        return typeof status === "string" ? status === "Enabled" : null;
      },
      fix: 'versioning_configuration { status = "Enabled" }',
    },
  ],
  aws_db_instance: [
    {
      label: "automated backups",
      severity: "high",
      isOn: (v) => (typeof v.backup_retention_period === "number" ? v.backup_retention_period > 0 : null),
      fix: "backup_retention_period = 7 (or more)",
    },
    {
      label: "deletion protection",
      severity: "medium",
      isOn: (v) => bool(v.deletion_protection),
      fix: "deletion_protection = true",
    },
    {
      label: "the final snapshot on delete",
      severity: "medium",
      isOn: (v) => (typeof v.skip_final_snapshot === "boolean" ? !v.skip_final_snapshot : null),
      fix: "skip_final_snapshot = false",
    },
  ],
  aws_rds_cluster: [
    {
      label: "deletion protection",
      severity: "medium",
      isOn: (v) => bool(v.deletion_protection),
      fix: "deletion_protection = true",
    },
    {
      label: "the final snapshot on delete",
      severity: "medium",
      isOn: (v) => (typeof v.skip_final_snapshot === "boolean" ? !v.skip_final_snapshot : null),
      fix: "skip_final_snapshot = false",
    },
  ],
  google_sql_database_instance: [
    {
      label: "automated backups",
      severity: "high",
      isOn: (v) => bool(first(first(v.settings).backup_configuration).enabled),
      fix: "settings { backup_configuration { enabled = true } }",
    },
    {
      label: "deletion protection",
      severity: "medium",
      isOn: (v) => bool(v.deletion_protection),
      fix: "deletion_protection = true",
    },
  ],
  google_storage_bucket: [
    {
      label: "versioning",
      severity: "high",
      isOn: (v) => bool(first(v.versioning).enabled),
      fix: "versioning { enabled = true }",
    },
  ],
};

/**
 * Flags protections against data loss being switched off on an existing resource (or missing from its
 * replacement): backups, point-in-time recovery, versioning, deletion protection. Only on→off transitions
 * count, so new resources and settings that were already off are left to the LLM.
 */
export const dataProtectionCheck: Precheck = (rc) => {
  const protections = PROTECTIONS[rc.type];
  const kind = changeKind(rc.change.actions);
  if (!protections || (kind !== "update" && kind !== "replace")) return [];
  const before = (rc.change.before ?? {}) as Values;
  const after = (rc.change.after ?? {}) as Values;

  const disabled = protections.filter((p) => p.isOn(before) === true && p.isOn(after) === false);
  if (!disabled.length) return [];

  return [
    finding(rc, "data-protection-disabled", {
      severity: maxSeverity(disabled.map((p) => p.severity)),
      category: "data-loss",
      issue:
        kind === "replace"
          ? `The replacement is created without ${disabled.map((p) => p.label).join(" or ")}, which the current resource has.`
          : `Turns off ${disabled.map((p) => p.label).join(" and ")}.`,
      blastRadius:
        "Deleted or corrupted data can no longer be recovered, whether from a mistake, a bad deploy or ransomware.",
      suggestion: `Keep ${disabled.map((p) => p.fix).join(" and ")}, unless this is intentional and the data is disposable.`,
    }),
  ];
};
