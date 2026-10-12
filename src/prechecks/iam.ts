import { maxSeverity, type Severity } from "../schema.js";
import { after, asArray, finding, isPublicPrincipal, parsePolicy, type Precheck } from "./util.js";

const POLICY_ATTRS: Record<string, string[]> = {
  aws_iam_policy: ["policy"],
  aws_iam_role_policy: ["policy"],
  aws_iam_user_policy: ["policy"],
  aws_iam_group_policy: ["policy"],
  aws_iam_role: ["assume_role_policy"],
};

export const iamCheck: Precheck = (rc) => {
  const attrs = POLICY_ATTRS[rc.type];
  const a = after(rc);
  if (!attrs || !a) return [];

  const docs = attrs.map((k) => a[k]);
  if (rc.type === "aws_iam_role") {
    for (const p of asArray<Record<string, unknown>>(a.inline_policy)) docs.push(p?.policy);
  }

  const problems: { severity: Severity; text: string }[] = [];
  for (const stmt of docs.flatMap(parsePolicy)) {
    if (stmt.Effect !== "Allow") continue;
    const actions = asArray<string>(stmt.Action);
    const resources = asArray<string>(stmt.Resource);
    const allActions = actions.includes("*");
    const allResources = resources.includes("*");
    const label = stmt.Sid ? `statement "${stmt.Sid}"` : "a statement";

    if (allActions && allResources) problems.push({ severity: "critical", text: `${label} allows Action "*" on Resource "*" (full admin)` });
    else if (allActions) problems.push({ severity: "high", text: `${label} allows Action "*"` });
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

  if (!problems.length) return [];
  return [
    finding(rc, "iam-wildcard", {
      severity: maxSeverity(problems.map((p) => p.severity)),
      category: "iam",
      issue: `Overly broad IAM policy: ${problems.map((p) => p.text).join("; ")}.`,
      blastRadius: "Any principal holding this policy can act far beyond its intended scope, including privilege escalation.",
      suggestion: "Scope Action and Resource to the specific operations and ARNs needed (least privilege).",
    }),
  ];
};
