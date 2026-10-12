import { describe, expect, it } from "vitest";
import { changedResources } from "../src/plan/load.js";
import { runPrechecks } from "../src/prechecks/index.js";
import { encryptionCheck } from "../src/prechecks/encryption.js";
import { actionMatches, iamCheck } from "../src/prechecks/iam.js";
import { ingressCheck } from "../src/prechecks/ingress.js";
import { s3PublicCheck } from "../src/prechecks/s3-public.js";
import { tagsCheck } from "../src/prechecks/tags.js";
import { destroyCheck } from "../src/prechecks/destroy.js";
import { evalPlan, rc } from "./helpers.js";

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
    const [f] = iamCheck(rc("aws_iam_policy", { policy: policy({ Effect: "Allow", Action: "s3:*", Resource: "arn:aws:s3:::b/*" }) }), ctx);
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
    expect(iamCheck(rc("aws_iam_policy", { policy: policy({ Effect: "Deny", Action: "*", Resource: "*" }) }), ctx)).toEqual([]);
    expect(iamCheck(rc("aws_iam_policy", {}), ctx)).toEqual([]);
  });
});

describe("iamCheck privilege escalation", () => {
  const allow = (Action: string | string[], Resource: string | string[]) => ({ Effect: "Allow", Action, Resource });
  const check = (...stmts: object[]) => iamCheck(rc("aws_iam_policy", { policy: policy(...stmts) }), ctx);

  it("flags iam:PassRole on any role combined with compute creation, even across statements", () => {
    const [f] = check(allow("iam:PassRole", "*"), allow("lambda:CreateFunction", "arn:aws:lambda:us-east-1:123456789012:function:app-*"));
    expect(f).toMatchObject({ severity: "high", ruleId: "iam-privilege-escalation" });
    expect(f!.issue).toContain("lambda:CreateFunction");
  });

  it("understands wildcard actions and wildcard role ARNs", () => {
    const [f] = check(allow(["iam:Pass*", "ec2:Run*"], "arn:aws:iam::123456789012:role/*"));
    expect(f).toMatchObject({ severity: "high", ruleId: "iam-privilege-escalation" });
  });

  it("does not flag PassRole scoped to a specific role", () => {
    expect(check(allow("iam:PassRole", "arn:aws:iam::123456789012:role/app-lambda"), allow("lambda:CreateFunction", "arn:aws:lambda:us-east-1:123456789012:function:app"))).toEqual([]);
  });

  it("does not flag PassRole without a compute action", () => {
    const [f] = check(allow("iam:PassRole", "*"));
    expect(f).toMatchObject({ severity: "medium", ruleId: "iam-wildcard" });
  });

  it("flags self-escalating IAM actions on any resource, but not on a specific one", () => {
    expect(check(allow("iam:CreatePolicyVersion", "*"))[0]).toMatchObject({ severity: "high", ruleId: "iam-privilege-escalation" });
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
    const [f] = ingressCheck(rc("aws_vpc_security_group_ingress_rule", { cidr_ipv6: "::/0", from_port: 5432, to_port: 5432, ip_protocol: "tcp" }), ctx);
    expect(f!.severity).toBe("critical");
  });

  it("treats protocol -1 as all traffic", () => {
    const [f] = ingressCheck(rc("aws_security_group_rule", { type: "ingress", protocol: "-1", from_port: 0, to_port: 0, cidr_blocks: ["0.0.0.0/0"] }), ctx);
    expect(f!.severity).toBe("critical");
    expect(f!.issue).toContain("all ports");
  });

  it("ignores egress rules and private CIDRs", () => {
    expect(ingressCheck(rc("aws_security_group_rule", { type: "egress", protocol: "-1", cidr_blocks: ["0.0.0.0/0"] }), ctx)).toEqual([]);
    expect(ingressCheck(rc("aws_security_group_rule", { type: "ingress", from_port: 22, to_port: 22, cidr_blocks: ["10.0.0.0/8"] }), ctx)).toEqual([]);
  });
});

describe("s3PublicCheck", () => {
  it("flags public-read-write ACLs as critical", () => {
    const [f] = s3PublicCheck(rc("aws_s3_bucket_acl", { acl: "public-read-write" }), ctx);
    expect(f!.severity).toBe("critical");
  });

  it("does not flag bucket policies with a Condition", () => {
    const p = policy({ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "*", Condition: { StringEquals: { "aws:SourceArn": "x" } } });
    expect(s3PublicCheck(rc("aws_s3_bucket_policy", { policy: p }), ctx)).toEqual([]);
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
