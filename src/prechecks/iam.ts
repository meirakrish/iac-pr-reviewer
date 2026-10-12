import { maxSeverity, type Severity } from "../schema.js";
import {
  after,
  asArray,
  finding,
  isPublicPrincipal,
  parsePolicy,
  type PolicyStatement,
  type Precheck,
} from "./util.js";

const POLICY_ATTRS: Record<string, string[]> = {
  aws_iam_policy: ["policy"],
  aws_iam_role_policy: ["policy"],
  aws_iam_user_policy: ["policy"],
  aws_iam_group_policy: ["policy"],
  aws_iam_role: ["assume_role_policy"],
};

/**
 * Actions that run compute under a role chosen by the caller; with iam:PassRole on any role, that's an escalation path.
 */
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
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  );
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
    if (compute.length)
      problems.push(
        `iam:PassRole on any role combined with ${compute.join(", ")} lets the holder run code as any role, including admin roles`,
      );
  }
  const direct = grantedActions(stmts, DIRECT_ESCALATION, true);
  if (direct.length)
    problems.push(`${direct.join(", ")} on any resource lets the holder grant itself more permissions`);
  return problems;
}

const awsIamCheck: Precheck = (rc) => {
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
      if (svcWildcards.length)
        problems.push({
          severity: allResources ? "high" : "medium",
          text: `${label} allows service-wide ${svcWildcards.join(", ")}`,
        });
      else if (allResources)
        problems.push({
          severity: "medium",
          text: `${label} grants ${actions.join(", ") || "its actions"} on Resource "*"`,
        });
    }
    if (stmt.NotAction)
      problems.push({ severity: "high", text: `${label} uses Allow + NotAction, which grants everything not listed` });
    if (stmt.Principal !== undefined && isPublicPrincipal(stmt.Principal) && !stmt.Condition) {
      problems.push({
        severity: "critical",
        text: `${label} trusts Principal "*" with no Condition — anyone can assume it`,
      });
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

// ---------------------------------------------------------------- Azure RBAC

/** Built-in role GUIDs, for assignments that use role_definition_id instead of a name. */
const AZURE_ROLE_IDS: Record<string, string> = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "Contributor",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
  "f58310d9-a9f6-439a-9e8d-f62e7b41a168": "Role Based Access Control Administrator",
};

/** Roles that can grant any role to anyone, including themselves. */
const AZURE_ESCALATION_ROLES = new Set(["User Access Administrator", "Role Based Access Control Administrator"]);

function azureScopeLevel(scope: unknown): "management group" | "subscription" | "resource group" | "resource" | null {
  if (typeof scope !== "string") return null;
  if (/managementGroups\/[^/]+\/?$/i.test(scope)) return "management group";
  if (/^\/subscriptions\/[^/]+\/?$/i.test(scope)) return "subscription";
  if (/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/?$/i.test(scope)) return "resource group";
  return "resource";
}

const azureIamCheck: Precheck = (rc) => {
  const a = after(rc);
  if (!a) return [];

  if (rc.type === "azurerm_role_assignment") {
    const id =
      String(a.role_definition_id ?? "")
        .split("/")
        .pop()
        ?.toLowerCase() ?? "";
    const role = typeof a.role_definition_name === "string" ? a.role_definition_name : AZURE_ROLE_IDS[id];
    if (!role) return [];
    const level = azureScopeLevel(a.scope);
    const broad = level === "subscription" || level === "management group";
    let severity: Severity | null = null;
    if (role === "Owner") severity = broad ? "critical" : "high";
    else if (AZURE_ESCALATION_ROLES.has(role)) severity = broad ? "critical" : "high";
    else if (role === "Contributor" && broad) severity = "medium";
    if (!severity) return [];
    const where = level ? `at ${level} scope` : "at a scope not known until apply";
    return [
      finding(rc, AZURE_ESCALATION_ROLES.has(role) || role === "Owner" ? "azure-privileged-role" : "azure-broad-role", {
        severity,
        category: "iam",
        issue: `Assigns "${role}" ${where}${role === "Contributor" ? "" : "; this role can grant itself or others any permission"}.`,
        blastRadius: broad
          ? `The principal gets ${role === "Contributor" ? "write access to every resource" : "full control, including access management,"} across the entire ${level}.`
          : "The principal gets full control of the scoped resources, including who else can access them.",
        suggestion:
          "Assign the narrowest built-in role that fits (e.g. a service-specific Contributor role) at the smallest scope; use PIM for standing admin access.",
      }),
    ];
  }

  if (rc.type === "azurerm_role_definition") {
    const perms = asArray<Record<string, unknown>>(a.permissions);
    const actions = perms.flatMap((p) => asArray<string>(p.actions));
    const notActions = perms.flatMap((p) => asArray<string>(p.not_actions));
    const problems: { severity: Severity; text: string }[] = [];
    if (actions.includes("*")) {
      const excludesAuth = notActions.some((n) => /^Microsoft\.Authorization\/\*/i.test(n));
      problems.push(
        excludesAuth
          ? { severity: "high", text: 'actions = ["*"] (Contributor-equivalent)' }
          : {
              severity: "critical",
              text: 'actions = ["*"] without excluding Microsoft.Authorization (Owner-equivalent)',
            },
      );
    }
    const authWrite = actions.filter((x) =>
      /^Microsoft\.Authorization\/(\*|roleAssignments\/(\*|write)|roleDefinitions\/(\*|write))/i.test(x),
    );
    if (authWrite.length)
      problems.push({ severity: "high", text: `${authWrite.join(", ")} lets holders grant themselves any role` });
    if (!problems.length) return [];
    return [
      finding(rc, "azure-custom-role-wildcard", {
        severity: maxSeverity(problems.map((p) => p.severity)),
        category: "iam",
        issue: `Custom role is overly broad: ${problems.map((p) => p.text).join("; ")}.`,
        blastRadius:
          "Anyone assigned this role can act far beyond its intended purpose, up to taking over access management.",
        suggestion:
          "List the specific resource-provider actions needed and add Microsoft.Authorization/*/Write to not_actions.",
      }),
    ];
  }

  return [];
};

// ---------------------------------------------------------------- GCP IAM

const GCP_IAM_MEMBER_TYPES = /^google_(project|folder|organization)_iam_(member|binding)$/;
const GCP_PUBLIC_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);
/** Predefined roles that allow granting more access or impersonating other identities. */
const GCP_ESCALATION_ROLES = new Set([
  "roles/iam.securityAdmin",
  "roles/resourcemanager.projectIamAdmin",
  "roles/resourcemanager.folderIamAdmin",
  "roles/resourcemanager.organizationAdmin",
  "roles/iam.serviceAccountTokenCreator",
  "roles/iam.serviceAccountKeyAdmin",
  "roles/iam.serviceAccountUser",
  "roles/iam.roleAdmin",
]);

/** Permissions that grant more access directly. */
const GCP_SELF_GRANT = [
  "resourcemanager.projects.setIamPolicy",
  "resourcemanager.folders.setIamPolicy",
  "resourcemanager.organizations.setIamPolicy",
  "iam.roles.update",
  "iam.serviceAccountKeys.create",
  "iam.serviceAccounts.getAccessToken",
  "iam.serviceAccounts.signBlob",
  "iam.serviceAccounts.signJwt",
  "iam.serviceAccounts.implicitDelegation",
];
/** Permissions that run code as a chosen service account when combined with iam.serviceAccounts.actAs. */
const GCP_ACTAS_TARGETS = [
  "compute.instances.create",
  "cloudfunctions.functions.create",
  "cloudfunctions.functions.update",
  "run.services.create",
  "run.jobs.create",
  "cloudbuild.builds.create",
  "dataflow.jobs.create",
  "composer.environments.create",
  "deploymentmanager.deployments.create",
  "container.clusters.create",
];

const gcpIamCheck: Precheck = (rc) => {
  const a = after(rc);
  if (!a) return [];

  if (GCP_IAM_MEMBER_TYPES.test(rc.type)) {
    const role = String(a.role ?? "");
    const members = [...asArray<string>(a.member), ...asArray<string>(a.members)];
    const scope = rc.type.split("_")[1];
    const problems: { severity: Severity; text: string }[] = [];
    const publicMembers = members.filter((m) => GCP_PUBLIC_MEMBERS.has(m));
    if (publicMembers.length)
      problems.push({
        severity: "critical",
        text: `grants ${role} to ${publicMembers.join(", ")} (anyone on the internet)`,
      });
    if (role === "roles/owner") problems.push({ severity: "critical", text: `grants roles/owner on the ${scope}` });
    else if (role === "roles/editor")
      problems.push({
        severity: "high",
        text: `grants roles/editor (write access to almost every resource) on the ${scope}`,
      });
    else if (GCP_ESCALATION_ROLES.has(role))
      problems.push({
        severity: "high",
        text: `grants ${role} on the ${scope}, which allows granting more access or impersonating service accounts`,
      });
    if (!problems.length) return [];
    return [
      finding(rc, "gcp-privileged-role", {
        severity: maxSeverity(problems.map((p) => p.severity)),
        category: "iam",
        issue: `Overly broad IAM grant: ${problems.map((p) => p.text).join("; ")}.`,
        blastRadius: `The member${members.length === 1 ? "" : "s"} can act far beyond their intended scope across the whole ${scope}, potentially escalating to full control.`,
        suggestion:
          "Grant the narrowest predefined role at the smallest resource scope; avoid basic roles (owner/editor) and public members.",
      }),
    ];
  }

  if (rc.type === "google_project_iam_custom_role" || rc.type === "google_organization_iam_custom_role") {
    const perms = asArray<string>(a.permissions);
    const problems: string[] = [];
    const selfGrant = GCP_SELF_GRANT.filter((p) => perms.includes(p));
    if (selfGrant.length) problems.push(`${selfGrant.join(", ")} lets holders grant themselves more access`);
    if (perms.includes("iam.serviceAccounts.actAs")) {
      const compute = GCP_ACTAS_TARGETS.filter((p) => perms.includes(p));
      if (compute.length)
        problems.push(
          `iam.serviceAccounts.actAs combined with ${compute.join(", ")} lets holders run code as any service account they can use`,
        );
    }
    if (!problems.length) return [];
    return [
      finding(rc, "iam-privilege-escalation", {
        severity: "high",
        category: "iam",
        issue: `Custom role enables privilege escalation: ${problems.join("; ")}.`,
        blastRadius:
          "Anyone with this role can escalate to the permissions of more privileged identities in the project.",
        suggestion: "Remove the escalation permissions, or restrict actAs via IAM on specific service accounts.",
      }),
    ];
  }

  return [];
};

export const iamCheck: Precheck = (rc, ctx) => [
  ...awsIamCheck(rc, ctx),
  ...azureIamCheck(rc, ctx),
  ...gcpIamCheck(rc, ctx),
];
