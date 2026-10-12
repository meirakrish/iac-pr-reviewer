import { maxSeverity, type Severity } from "../schema.js";
import { after, asArray, finding, isPublicPrincipal, parsePolicy, type PolicyStatement, type Precheck } from "./util.js";

const POLICY_ATTRS: Record<string, string[]> = {
  aws_iam_policy: ["policy"],
  aws_iam_role_policy: ["policy"],
  aws_iam_user_policy: ["policy"],
  aws_iam_group_policy: ["policy"],
  aws_iam_role: ["assume_role_policy"],
};

/** Actions that run compute under a role chosen by the caller; with iam:PassRole on any role, that's an escalation path. */
const PASSROLE_TARGETS = [
  "lambda:CreateFunction",
  "lambda:UpdateFunctionConfiguration",
  "ec2:RunInstances",
  "ecs:RegisterTaskDefinition",
  "ecs:CreateService",
  "glue:CreateDevEndpoint",
  "glue:CreateJob",
  "cloudformation:CreateStack",
  "cloudformation:UpdateStack",
  "datapipeline:CreatePipeline",
  "sagemaker:CreateNotebookInstance",
  "sagemaker:CreateTrainingJob",
  "sagemaker:CreateProcessingJob",
  "codebuild:CreateProject",
  "states:CreateStateMachine",
  "apprunner:CreateService",
];

/** IAM actions that let a principal grant itself (or others) more access when allowed on any resource. */
const DIRECT_ESCALATION = [
  "iam:CreatePolicyVersion",
  "iam:SetDefaultPolicyVersion",
  "iam:AttachUserPolicy",
  "iam:AttachRolePolicy",
  "iam:AttachGroupPolicy",
  "iam:PutUserPolicy",
  "iam:PutRolePolicy",
  "iam:PutGroupPolicy",
  "iam:CreateAccessKey",
  "iam:CreateLoginProfile",
  "iam:UpdateLoginProfile",
  "iam:UpdateAssumeRolePolicy",
  "iam:AddUserToGroup",
];

/** IAM action patterns are case-insensitive globs: "*" and "?" wildcards. */
export function actionMatches(pattern: string, action: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return re.test(action);
}

/** "*", or an ARN whose resource part is a wildcard (e.g. arn:aws:iam::123:role/*). */
function isBroadResource(r: string): boolean {
  return r === "*" || /[:/]\*$/.test(r);
}

/** Actions from `candidates` that some Allow statement grants, optionally only counting broad resources. */
function grantedActions(stmts: PolicyStatement[], candidates: string[], broadOnly: boolean): string[] {
  return candidates.filter((action) =>
    stmts.some(
      (s) =>
        asArray<string>(s.Action).some((p) => actionMatches(p, action)) &&
        (!broadOnly || asArray<string>(s.Resource).some(isBroadResource)),
    ),
  );
}

function escalationProblems(stmts: PolicyStatement[]): string[] {
  const problems: string[] = [];
  if (grantedActions(stmts, ["iam:PassRole"], true).length) {
    const compute = grantedActions(stmts, PASSROLE_TARGETS, false);
    if (compute.length) problems.push(`iam:PassRole on any role combined with ${compute.join(", ")} lets the holder run code as any role, including admin roles`);
  }
  const direct = grantedActions(stmts, DIRECT_ESCALATION, true);
  if (direct.length) problems.push(`${direct.join(", ")} on any resource lets the holder grant itself more permissions`);
  return problems;
}

export const iamCheck: Precheck = (rc) => {
  const attrs = POLICY_ATTRS[rc.type];
  const a = after(rc);
  if (!attrs || !a) return [];

  const docs = attrs.map((k) => a[k]);
  if (rc.type === "aws_iam_role") {
    for (const p of asArray<Record<string, unknown>>(a.inline_policy)) docs.push(p?.policy);
  }

  const problems: { severity: Severity; text: string }[] = [];
  const allows = docs.flatMap(parsePolicy).filter((s) => s.Effect === "Allow");
  let fullAdmin = false;

  for (const stmt of allows) {
    const actions = asArray<string>(stmt.Action);
    const resources = asArray<string>(stmt.Resource);
    const allActions = actions.includes("*");
    const allResources = resources.includes("*");
    const label = stmt.Sid ? `statement "${stmt.Sid}"` : "a statement";

    if (allActions && allResources) {
      fullAdmin = true;
      problems.push({ severity: "critical", text: `${label} allows Action "*" on Resource "*" (full admin)` });
    } else if (allActions) problems.push({ severity: "high", text: `${label} allows Action "*"` });
    else {
      const svcWildcards = actions.filter((x) => /^[\w-]+:\*$/.test(x));
      if (svcWildcards.length) problems.push({ severity: allResources ? "high" : "medium", text: `${label} allows service-wide ${svcWildcards.join(", ")}` });
      else if (allResources) problems.push({ severity: "medium", text: `${label} grants ${actions.join(", ") || "its actions"} on Resource "*"` });
    }
    if (stmt.NotAction) problems.push({ severity: "high", text: `${label} uses Allow + NotAction, which grants everything not listed` });
    if (stmt.Principal !== undefined && isPublicPrincipal(stmt.Principal) && !stmt.Condition) {
      problems.push({ severity: "critical", text: `${label} trusts Principal "*" with no Condition — anyone can assume it` });
    }
  }

  // Full admin already implies every escalation path; listing them would only add noise.
  const escalation = fullAdmin ? [] : escalationProblems(allows);
  for (const text of escalation) problems.push({ severity: "high", text: `privilege escalation: ${text}` });

  if (!problems.length) return [];
  return [
    finding(rc, escalation.length ? "iam-privilege-escalation" : "iam-wildcard", {
      severity: maxSeverity(problems.map((p) => p.severity)),
      category: "iam",
      issue: `Overly broad IAM policy: ${problems.map((p) => p.text).join("; ")}.`,
      blastRadius: escalation.length
        ? "Whoever holds this policy can escalate to administrator-level access in the account."
        : "Any principal holding this policy can act far beyond its intended scope, including privilege escalation.",
      suggestion: escalation.length
        ? "Scope iam:PassRole to the specific role ARNs needed (optionally with an iam:PassedToService condition), and scope IAM write actions to specific resources."
        : "Scope Action and Resource to the specific operations and ARNs needed (least privilege).",
    }),
  ];
};
