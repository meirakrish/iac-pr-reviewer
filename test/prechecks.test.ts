import { describe, expect, it } from "vitest";
import { changedResources } from "../src/plan/load.js";
import { runPrechecks } from "../src/prechecks/index.js";
import { encryptionCheck } from "../src/prechecks/encryption.js";
import { actionMatches, iamCheck } from "../src/prechecks/iam.js";
import { ingressCheck } from "../src/prechecks/ingress.js";
import { publicStorageCheck } from "../src/prechecks/public-storage.js";
import { tagsCheck } from "../src/prechecks/tags.js";
import { destroyCheck } from "../src/prechecks/destroy.js";
import { dataProtectionCheck } from "../src/prechecks/data-protection.js";
import { evalPlan, rc } from "./helpers.js";
import type { Action } from "../src/plan/types.js";

const ctx = { requiredTags: [] };
const policy = (...Statement: object[]) => JSON.stringify({ Version: "2012-10-17", Statement });

describe("prechecks on real plans", () => {
  it.each([
    ["01-safe-tag-update", []],
    ["02-safe-scoped-lambda-role", []],
    ["03-iam-admin-wildcard", ["critical:iam-wildcard:aws_iam_policy.ci_deploy"]],
    ["04-open-ssh", ["critical:open-ingress:aws_security_group.bastion"]],
    ["06-rds-destroy", ["critical:resource-destroy:aws_db_instance.orders"]],
    ["08-ec2-ami-replace", ["high:resource-replace:aws_instance.api"]],
    ["09-iam-passrole-escalation", ["high:iam-privilege-escalation:aws_iam_policy.deployer"]],
    ["11-safe-alb-https", ["low:open-ingress:aws_security_group.alb"]],
    ["12-azure-open-rdp", ["critical:open-ingress:azurerm_network_security_group.jumpbox"]],
    ["14-azure-owner-subscription", ["critical:azure-privileged-role:azurerm_role_assignment.ci_owner"]],
    ["15-azure-sql-open-firewall", ["critical:open-ingress:azurerm_mssql_firewall_rule.everyone"]],
    ["16-azure-safe-private-vm", []],
    ["17-gcp-public-bucket", ["high:gcs-public-iam:google_storage_bucket_iam_member.public_read"]],
    ["18-gcp-open-ssh", ["critical:open-ingress:google_compute_firewall.allow_ssh"]],
    ["20-gcp-sql-destroy", ["critical:resource-destroy:google_sql_database_instance.billing"]],
    ["22-gcp-safe-iap-ssh", []],
  ])("%s", (name, expected) => {
    const findings = runPrechecks(changedResources(evalPlan(name)), ctx);
    expect(findings.map((f) => `${f.severity}:${f.ruleId}:${f.resource}`)).toEqual(expected);
  });
});

describe("destroyCheck", () => {
  it("rates create_before_destroy replacements of stateless resources as medium", () => {
    const [f] = destroyCheck(rc("aws_lambda_function", {}, ["create", "delete"]), ctx);
    expect(f!.severity).toBe("medium");
  });

  it("ignores plain creates and updates", () => {
    expect(destroyCheck(rc("aws_db_instance", {}, ["update"]), ctx)).toEqual([]);
  });
});

describe("iamCheck", () => {
  it("flags service-wide wildcards", () => {
    const [f] = iamCheck(
      rc("aws_iam_policy", { policy: policy({ Effect: "Allow", Action: "s3:*", Resource: "arn:aws:s3:::b/*" }) }),
      ctx,
    );
    expect(f!.severity).toBe("medium");
  });

  it("flags role trust policies open to Principal *", () => {
    const trust = policy({ Effect: "Allow", Principal: { AWS: "*" }, Action: "sts:AssumeRole" });
    const [f] = iamCheck(rc("aws_iam_role", { assume_role_policy: trust }), ctx);
    expect(f!.severity).toBe("critical");
  });

  it("checks inline policies on roles", () => {
    const inline = [{ name: "x", policy: policy({ Effect: "Allow", Action: "*", Resource: "*" }) }];
    expect(iamCheck(rc("aws_iam_role", { assume_role_policy: "", inline_policy: inline }), ctx)).toHaveLength(1);
  });

  it("ignores Deny statements and unknown (unparseable) policies", () => {
    expect(
      iamCheck(rc("aws_iam_policy", { policy: policy({ Effect: "Deny", Action: "*", Resource: "*" }) }), ctx),
    ).toEqual([]);
    expect(iamCheck(rc("aws_iam_policy", {}), ctx)).toEqual([]);
  });
});

describe("iamCheck privilege escalation", () => {
  const allow = (Action: string | string[], Resource: string | string[]) => ({ Effect: "Allow", Action, Resource });
  const check = (...stmts: object[]) => iamCheck(rc("aws_iam_policy", { policy: policy(...stmts) }), ctx);

  it("flags iam:PassRole on any role combined with compute creation, even across statements", () => {
    const [f] = check(
      allow("iam:PassRole", "*"),
      allow("lambda:CreateFunction", "arn:aws:lambda:us-east-1:123456789012:function:app-*"),
    );
    expect(f).toMatchObject({ severity: "high", ruleId: "iam-privilege-escalation" });
    expect(f!.issue).toContain("lambda:CreateFunction");
  });

  it("understands wildcard actions and wildcard role ARNs", () => {
    const [f] = check(allow(["iam:Pass*", "ec2:Run*"], "arn:aws:iam::123456789012:role/*"));
    expect(f).toMatchObject({ severity: "high", ruleId: "iam-privilege-escalation" });
  });

  it("does not flag PassRole scoped to a specific role", () => {
    expect(
      check(
        allow("iam:PassRole", "arn:aws:iam::123456789012:role/app-lambda"),
        allow("lambda:CreateFunction", "arn:aws:lambda:us-east-1:123456789012:function:app"),
      ),
    ).toEqual([]);
  });

  it("does not flag PassRole without a compute action", () => {
    const [f] = check(allow("iam:PassRole", "*"));
    expect(f).toMatchObject({ severity: "medium", ruleId: "iam-wildcard" });
  });

  it("flags self-escalating IAM actions on any resource, but not on a specific one", () => {
    expect(check(allow("iam:CreatePolicyVersion", "*"))[0]).toMatchObject({
      severity: "high",
      ruleId: "iam-privilege-escalation",
    });
    expect(check(allow("iam:CreatePolicyVersion", "arn:aws:iam::123456789012:policy/app"))).toEqual([]);
  });

  it("does not add escalation noise to full-admin policies", () => {
    const [f] = check(allow("*", "*"));
    expect(f).toMatchObject({ severity: "critical", ruleId: "iam-wildcard" });
    expect(f!.issue).not.toContain("privilege escalation");
  });

  it("matches IAM action globs case-insensitively", () => {
    expect(actionMatches("IAM:passrole", "iam:PassRole")).toBe(true);
    expect(actionMatches("lambda:Create*", "lambda:CreateFunction")).toBe(true);
    expect(actionMatches("lambda:Create?", "lambda:CreateFunction")).toBe(false);
  });
});

describe("ingressCheck", () => {
  it("handles aws_vpc_security_group_ingress_rule with IPv6", () => {
    const [f] = ingressCheck(
      rc("aws_vpc_security_group_ingress_rule", {
        cidr_ipv6: "::/0",
        from_port: 5432,
        to_port: 5432,
        ip_protocol: "tcp",
      }),
      ctx,
    );
    expect(f!.severity).toBe("critical");
  });

  it("treats protocol -1 as all traffic", () => {
    const [f] = ingressCheck(
      rc("aws_security_group_rule", {
        type: "ingress",
        protocol: "-1",
        from_port: 0,
        to_port: 0,
        cidr_blocks: ["0.0.0.0/0"],
      }),
      ctx,
    );
    expect(f!.severity).toBe("critical");
    expect(f!.issue).toContain("all ports");
  });

  it("ignores egress rules and private CIDRs", () => {
    expect(
      ingressCheck(rc("aws_security_group_rule", { type: "egress", protocol: "-1", cidr_blocks: ["0.0.0.0/0"] }), ctx),
    ).toEqual([]);
    expect(
      ingressCheck(
        rc("aws_security_group_rule", { type: "ingress", from_port: 22, to_port: 22, cidr_blocks: ["10.0.0.0/8"] }),
        ctx,
      ),
    ).toEqual([]);
  });
});

describe("publicStorageCheck", () => {
  it("flags public-read-write ACLs as critical", () => {
    const [f] = publicStorageCheck(rc("aws_s3_bucket_acl", { acl: "public-read-write" }), ctx);
    expect(f!.severity).toBe("critical");
  });

  it("does not flag bucket policies with a Condition", () => {
    const p = policy({
      Effect: "Allow",
      Principal: "*",
      Action: "s3:GetObject",
      Resource: "*",
      Condition: { StringEquals: { "aws:SourceArn": "x" } },
    });
    expect(publicStorageCheck(rc("aws_s3_bucket_policy", { policy: p }), ctx)).toEqual([]);
  });
});

describe("encryptionCheck", () => {
  it("does not flag attributes that are unknown at plan time", () => {
    expect(encryptionCheck(rc("aws_db_instance", { engine: "postgres" }), ctx)).toEqual([]);
  });

  it("flags unencrypted EC2 block devices", () => {
    const [f] = encryptionCheck(rc("aws_instance", { root_block_device: [{ encrypted: false }] }), ctx);
    expect(f!.issue).toContain("root_block_device[0].encrypted");
  });
});

describe("tagsCheck", () => {
  it("flags taggable resources with no tags by default", () => {
    expect(tagsCheck(rc("aws_sqs_queue", { tags: null, tags_all: {} }), ctx)).toHaveLength(1);
  });

  it("checks required tags against tags_all (includes provider default_tags)", () => {
    const r = rc("aws_sqs_queue", { tags: { Team: "a" }, tags_all: { Team: "a", Environment: "prod" } });
    expect(tagsCheck(r, { requiredTags: ["Team", "Environment"] })).toEqual([]);
    const [f] = tagsCheck(r, { requiredTags: ["Team", "Owner"] });
    expect(f!.issue).toContain("Owner");
  });

  it("ignores resources without a tags attribute", () => {
    expect(tagsCheck(rc("aws_iam_role_policy_attachment", { role: "x" }), ctx)).toEqual([]);
  });
});

describe("Azure rules", () => {
  const nsgRule = (o: object) => ({
    direction: "Inbound",
    access: "Allow",
    protocol: "Tcp",
    source_address_prefix: "*",
    destination_port_range: "22",
    ...o,
  });

  it("treats NSG wildcard ports and port lists correctly", () => {
    expect(
      ingressCheck(rc("azurerm_network_security_rule", nsgRule({ destination_port_range: "*" })), ctx)[0]!.issue,
    ).toContain("all ports");
    const [f] = ingressCheck(
      rc(
        "azurerm_network_security_rule",
        nsgRule({ destination_port_range: null, destination_port_ranges: ["443", "8000-8100"] }),
      ),
      ctx,
    );
    expect(f!.severity).toBe("high");
  });

  it("ignores Deny and Outbound NSG rules", () => {
    expect(ingressCheck(rc("azurerm_network_security_rule", nsgRule({ access: "Deny" })), ctx)).toEqual([]);
    expect(ingressCheck(rc("azurerm_network_security_rule", nsgRule({ direction: "Outbound" })), ctx)).toEqual([]);
  });

  it("rates the 'Allow Azure services' firewall rule as medium", () => {
    const [f] = ingressCheck(
      rc("azurerm_postgresql_flexible_server_firewall_rule", {
        start_ip_address: "0.0.0.0",
        end_ip_address: "0.0.0.0",
      }),
      ctx,
    );
    expect(f!.severity).toBe("medium");
  });

  it("resolves built-in role GUIDs and scales severity with scope", () => {
    const owner =
      "/subscriptions/x/providers/Microsoft.Authorization/roleDefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
    expect(
      iamCheck(
        rc("azurerm_role_assignment", { role_definition_id: owner, scope: "/subscriptions/x/resourceGroups/rg" }),
        ctx,
      )[0]!.severity,
    ).toBe("high");
    expect(
      iamCheck(
        rc("azurerm_role_assignment", {
          role_definition_name: "User Access Administrator",
          scope: "/providers/Microsoft.Management/managementGroups/root",
        }),
        ctx,
      )[0]!.severity,
    ).toBe("critical");
    expect(
      iamCheck(
        rc("azurerm_role_assignment", {
          role_definition_name: "Contributor",
          scope: "/subscriptions/x/resourceGroups/rg",
        }),
        ctx,
      ),
    ).toEqual([]);
    expect(
      iamCheck(rc("azurerm_role_assignment", { role_definition_name: "Reader", scope: "/subscriptions/x" }), ctx),
    ).toEqual([]);
  });

  it("flags wildcard custom roles unless Microsoft.Authorization is excluded", () => {
    const role = (not_actions: string[]) =>
      rc("azurerm_role_definition", { permissions: [{ actions: ["*"], not_actions }] });
    expect(iamCheck(role([]), ctx)[0]!.severity).toBe("critical");
    expect(iamCheck(role(["Microsoft.Authorization/*/Write"]), ctx)[0]!.severity).toBe("high");
  });

  it("flags weak TLS and plaintext on storage and Redis", () => {
    expect(
      encryptionCheck(
        rc("azurerm_storage_account", { https_traffic_only_enabled: true, min_tls_version: "TLS1_1" }),
        ctx,
      )[0]!.severity,
    ).toBe("medium");
    expect(
      encryptionCheck(
        rc("azurerm_storage_account", { https_traffic_only_enabled: true, min_tls_version: "TLS1_2" }),
        ctx,
      ),
    ).toEqual([]);
    expect(encryptionCheck(rc("azurerm_redis_cache", { non_ssl_port_enabled: true }), ctx)).toHaveLength(1);
  });

  it("only flags blob/container access on storage containers", () => {
    expect(publicStorageCheck(rc("azurerm_storage_container", { container_access_type: "private" }), ctx)).toEqual([]);
    expect(
      publicStorageCheck(rc("azurerm_storage_container", { container_access_type: "blob" }), ctx)[0]!.severity,
    ).toBe("high");
  });
});

describe("GCP rules", () => {
  const fw = (o: object) =>
    rc("google_compute_firewall", {
      direction: "INGRESS",
      source_ranges: ["0.0.0.0/0"],
      allow: [{ protocol: "tcp", ports: ["22"] }],
      ...o,
    });

  it("treats a firewall allow without ports, or protocol all, as all traffic", () => {
    expect(ingressCheck(fw({ allow: [{ protocol: "tcp", ports: [] }] }), ctx)[0]!.issue).toContain("all ports");
    expect(ingressCheck(fw({ allow: [{ protocol: "all" }] }), ctx)[0]!.severity).toBe("critical");
  });

  it("ignores disabled and egress firewalls", () => {
    expect(ingressCheck(fw({ disabled: true }), ctx)).toEqual([]);
    expect(ingressCheck(fw({ direction: "EGRESS" }), ctx)).toEqual([]);
  });

  it("does not flag Cloud SQL with 0.0.0.0/0 when public IP is disabled", () => {
    const settings = [{ ip_configuration: [{ ipv4_enabled: false, authorized_networks: [{ value: "0.0.0.0/0" }] }] }];
    expect(ingressCheck(rc("google_sql_database_instance", { settings }), ctx)).toEqual([]);
  });

  it("rates public write access on buckets as critical and allAuthenticatedUsers as public", () => {
    expect(
      publicStorageCheck(
        rc("google_storage_bucket_iam_binding", { role: "roles/storage.objectAdmin", members: ["allUsers"] }),
        ctx,
      )[0]!.severity,
    ).toBe("critical");
    const [f] = publicStorageCheck(
      rc("google_storage_bucket_iam_member", { role: "roles/storage.objectViewer", member: "allAuthenticatedUsers" }),
      ctx,
    );
    expect(f!.issue).toContain("any Google account");
  });

  it("grades project/folder/org grants by role", () => {
    const grant = (type: string, role: string, member = "user:a@example.com") =>
      iamCheck(rc(type, { role, member }), ctx);
    expect(grant("google_project_iam_member", "roles/editor")[0]!.severity).toBe("high");
    expect(grant("google_organization_iam_member", "roles/iam.serviceAccountTokenCreator")[0]!.severity).toBe("high");
    expect(grant("google_project_iam_member", "roles/viewer", "allUsers")[0]!.severity).toBe("critical");
    expect(grant("google_project_iam_member", "roles/storage.objectViewer")).toEqual([]);
  });

  it("flags custom roles with setIamPolicy but not actAs without compute", () => {
    expect(
      iamCheck(rc("google_project_iam_custom_role", { permissions: ["resourcemanager.projects.setIamPolicy"] }), ctx),
    ).toHaveLength(1);
    expect(
      iamCheck(
        rc("google_project_iam_custom_role", { permissions: ["iam.serviceAccounts.actAs", "storage.objects.get"] }),
        ctx,
      ),
    ).toEqual([]);
  });

  it("checks labels (not network tags) on GCP resources", () => {
    expect(
      tagsCheck(
        rc("google_compute_instance", { tags: ["ssh"], labels: { team: "a" }, terraform_labels: { team: "a" } }),
        ctx,
      ),
    ).toEqual([]);
    expect(
      tagsCheck(rc("google_compute_instance", { tags: ["ssh"], labels: null, terraform_labels: {} }), ctx)[0]!.issue,
    ).toContain("no labels");
    expect(
      tagsCheck(rc("google_storage_bucket", { labels: { team: "a" }, terraform_labels: { team: "a" } }), {
        requiredTags: ["Team"],
      }),
    ).toEqual([]);
  });
});

describe("dataProtectionCheck", () => {
  const change = (type: string, before: object, after: object, actions: Action[] = ["update"]) => ({
    ...rc(type, after as Record<string, unknown>, actions),
    change: { actions, before, after },
  });

  it("flags point-in-time recovery and deletion protection being turned off", () => {
    const [f] = dataProtectionCheck(
      change(
        "aws_dynamodb_table",
        { point_in_time_recovery: [{ enabled: true }], deletion_protection_enabled: true },
        { point_in_time_recovery: [{ enabled: false }], deletion_protection_enabled: false },
      ),
      ctx,
    );
    expect(f).toMatchObject({ severity: "high", category: "data-loss", ruleId: "data-protection-disabled" });
    expect(f!.issue).toBe("Turns off point-in-time recovery and deletion protection.");
  });

  it("flags a replacement that drops a protection the current resource has", () => {
    const [f] = dataProtectionCheck(
      change(
        "aws_dynamodb_table",
        { point_in_time_recovery: [{ enabled: true }] },
        { point_in_time_recovery: [{ enabled: false }] },
        ["delete", "create"],
      ),
      ctx,
    );
    expect(f!.issue).toContain("replacement is created without point-in-time recovery");
  });

  it("covers RDS backups, S3 versioning and GCP", () => {
    expect(
      dataProtectionCheck(
        change("aws_db_instance", { backup_retention_period: 7 }, { backup_retention_period: 0 }),
        ctx,
      )[0]!.severity,
    ).toBe("high");
    expect(
      dataProtectionCheck(
        change(
          "aws_s3_bucket_versioning",
          { versioning_configuration: [{ status: "Enabled" }] },
          { versioning_configuration: [{ status: "Suspended" }] },
        ),
        ctx,
      ),
    ).toHaveLength(1);
    const sql = (enabled: boolean) => ({ settings: [{ backup_configuration: [{ enabled }] }] });
    expect(dataProtectionCheck(change("google_sql_database_instance", sql(true), sql(false)), ctx)).toHaveLength(1);
  });

  it("ignores settings that were already off, turned on, unknown, or on new resources", () => {
    expect(
      dataProtectionCheck(
        change("aws_db_instance", { deletion_protection: false }, { deletion_protection: false }),
        ctx,
      ),
    ).toEqual([]);
    expect(
      dataProtectionCheck(
        change("aws_db_instance", { deletion_protection: false }, { deletion_protection: true }),
        ctx,
      ),
    ).toEqual([]);
    expect(dataProtectionCheck(change("aws_db_instance", { deletion_protection: true }, {}), ctx)).toEqual([]);
    expect(dataProtectionCheck(rc("aws_db_instance", { deletion_protection: false }), ctx)).toEqual([]);
  });
});
