import type { Severity } from "../schema.js";
import { after, finding, isPublicPrincipal, parsePolicy, type Precheck } from "./util.js";

const PUBLIC_ACLS: Record<string, Severity> = {
  "public-read": "high",
  "public-read-write": "critical",
  "authenticated-read": "high",
};

const BLOCK_FLAGS = ["block_public_acls", "block_public_policy", "ignore_public_acls", "restrict_public_buckets"];

export const s3PublicCheck: Precheck = (rc) => {
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
