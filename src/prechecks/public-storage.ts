import type { Severity } from "../schema.js";
import { after, asArray, finding, isPublicPrincipal, parsePolicy, type Precheck } from "./util.js";

const PUBLIC_ACLS: Record<string, Severity> = {
  "public-read": "high",
  "public-read-write": "critical",
  "authenticated-read": "high",
};

const BLOCK_FLAGS = ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"];

const s3Check: Precheck = (rc) => {
  const a = after(rc);
  if (!a) return [];

  if (rc.type === "aws_s3_bucket_acl" || rc.type === "aws_s3_bucket") {
    const acl = typeof a.acl === "string" ? a.acl : null;
    const severity = acl ? PUBLIC_ACLS[acl] : undefined;
    if (!severity) return [];
    return [
      finding(rc, "s3-public-acl", {
        severity,
        category: "public-storage",
        issue: `Bucket ACL is "${acl}", making objects ${acl === "public-read-write" ? "readable and writable" : "readable"} by anyone.`,
        blastRadius: "All objects in the bucket can be listed/downloaded from the internet" + (acl === "public-read-write" ? ", and anyone can upload or overwrite data." : "."),
        suggestion: 'Use a "private" ACL (or BucketOwnerEnforced ownership) and serve public content through CloudFront with OAC.',
      }),
    ];
  }

  if (rc.type === "aws_s3_bucket_public_access_block" || rc.type === "aws_s3_account_public_access_block") {
    const disabled = BLOCK_FLAGS.filter((f) => a[f] === false);
    if (!disabled.length) return [];
    const account = rc.type === "aws_s3_account_public_access_block";
    return [
      finding(rc, "s3-public-access-block", {
        severity: account ? "critical" : "high",
        category: "public-storage",
        issue: `Public access block has ${disabled.join(", ")} set to false${account ? " for the whole account" : ""}.`,
        blastRadius: account
          ? "Every bucket in the account can be made public by a single ACL or policy change."
          : "The bucket can be made public by an ACL or bucket policy.",
        suggestion: "Keep all four public-access-block flags true unless the bucket is intentionally public.",
      }),
    ];
  }

  if (rc.type === "aws_s3_bucket_policy") {
    const publicStmts = parsePolicy(a.policy).filter((s) => s.Effect === "Allow" && isPublicPrincipal(s.Principal) && !s.Condition);
    if (!publicStmts.length) return [];
    return [
      finding(rc, "s3-public-policy", {
        severity: "high",
        category: "public-storage",
        issue: 'Bucket policy allows Principal "*" with no Condition.',
        blastRadius: "Anyone on the internet can perform the allowed actions on this bucket's objects.",
        suggestion: "Restrict the Principal to specific accounts/roles, or add a Condition (e.g. aws:SourceArn for CloudFront).",
      }),
    ];
  }

  return [];
};

/** Azure containers allow anonymous reads via container_access_type; accounts gate it with allow_nested_items_to_be_public. */
const azureStorageCheck: Precheck = (rc) => {
  const a = after(rc);
  if (!a) return [];

  if (rc.type === "azurerm_storage_container") {
    const access = String(a.container_access_type ?? "private");
    if (access !== "blob" && access !== "container") return [];
    return [
      finding(rc, "azure-public-container", {
        severity: "high",
        category: "public-storage",
        issue: `Container access type is "${access}": anyone can read blobs${access === "container" ? " and list the container" : ""} without authentication.`,
        blastRadius: "Every blob in the container can be downloaded from the internet by anyone who knows or guesses the URL.",
        suggestion: 'Set container_access_type = "private" and share data with SAS tokens or a CDN with private origin access.',
      }),
    ];
  }

  if (rc.type === "azurerm_storage_account" && a.allow_nested_items_to_be_public === true) {
    return [
      finding(rc, "azure-storage-public-allowed", {
        severity: "low",
        category: "public-storage",
        issue: "Storage account allows containers to be made public (allow_nested_items_to_be_public = true).",
        blastRadius: "A single container setting is enough to expose data publicly.",
        suggestion: "Set allow_nested_items_to_be_public = false unless this account intentionally serves public content.",
      }),
    ];
  }

  return [];
};

const GCP_PUBLIC_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);
const GCP_PUBLIC_ACLS: Record<string, Severity> = { publicRead: "high", publicReadWrite: "critical" };

function isGcsWriteRole(role: string): boolean {
  return /objectAdmin|objectCreator|storage\.admin|legacyBucketWriter|legacyBucketOwner|objectUser/.test(role);
}

const gcsCheck: Precheck = (rc) => {
  const a = after(rc);
  if (!a) return [];

  if (rc.type === "google_storage_bucket_iam_member" || rc.type === "google_storage_bucket_iam_binding") {
    const members = [...asArray<string>(a.member), ...asArray<string>(a.members)].filter((m) => GCP_PUBLIC_MEMBERS.has(m));
    if (!members.length) return [];
    const role = String(a.role ?? "");
    const write = isGcsWriteRole(role);
    return [
      finding(rc, "gcs-public-iam", {
        severity: write ? "critical" : "high",
        category: "public-storage",
        issue: `Bucket grants ${role} to ${members.join(", ")}${members.includes("allAuthenticatedUsers") ? " (any Google account, not just your organization)" : ""}.`,
        blastRadius: write
          ? "Anyone on the internet can read, upload and overwrite objects in the bucket."
          : "Every object in the bucket can be downloaded by anyone on the internet.",
        suggestion: "Grant access to specific users, groups or service accounts; enforce public_access_prevention on the bucket.",
      }),
    ];
  }

  if (rc.type === "google_storage_bucket_acl" || rc.type === "google_storage_default_object_acl" || rc.type === "google_storage_object_acl") {
    const predefined = String(a.predefined_acl ?? "");
    const publicEntities = asArray<string>(a.role_entity).filter((e) => /:(allUsers|allAuthenticatedUsers)$/.test(e));
    const severity = GCP_PUBLIC_ACLS[predefined] ?? (publicEntities.length ? "high" : undefined);
    if (!severity) return [];
    return [
      finding(rc, "gcs-public-acl", {
        severity,
        category: "public-storage",
        issue: `Public ACL on GCS (${predefined || publicEntities.join(", ")}).`,
        blastRadius: "Objects are readable" + (severity === "critical" ? " and writable" : "") + " by anyone on the internet.",
        suggestion: "Remove public ACL entries; prefer uniform bucket-level access with IAM and public_access_prevention = \"enforced\".",
      }),
    ];
  }

  return [];
};

export const publicStorageCheck: Precheck = (rc, ctx) => [...s3Check(rc, ctx), ...azureStorageCheck(rc, ctx), ...gcsCheck(rc, ctx)];
