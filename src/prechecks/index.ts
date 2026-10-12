import { SEVERITY_ORDER, type Finding } from "../schema.js";
import type { ResourceChange } from "../plan/types.js";
import { dataProtectionCheck } from "./data-protection.js";
import { destroyCheck } from "./destroy.js";
import { encryptionCheck } from "./encryption.js";
import { iamCheck } from "./iam.js";
import { ingressCheck } from "./ingress.js";
import { publicStorageCheck } from "./public-storage.js";
import { tagsCheck } from "./tags.js";
import type { Precheck, PrecheckContext } from "./util.js";

export type { PrecheckContext } from "./util.js";

export const PRECHECKS: Precheck[] = [
  destroyCheck,
  dataProtectionCheck,
  iamCheck,
  ingressCheck,
  publicStorageCheck,
  encryptionCheck,
  tagsCheck,
];

/** Run every deterministic check against the changed resources. Findings are sorted most severe first. */
export function runPrechecks(changes: ResourceChange[], ctx: PrecheckContext): Finding[] {
  const findings = collapseModuleMoves(
    changes.flatMap((rc) => PRECHECKS.flatMap((check) => check(rc, ctx))),
    ctx,
  );
  return findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
}

/**
 * A renamed module produces one "missing moved block" finding per resource, all with the same fix.
 * Report it once per module, listing the affected resources.
 */
function collapseModuleMoves(findings: Finding[], ctx: PrecheckContext): Finding[] {
  const groups = new Map<string, Finding[]>();
  const rest: Finding[] = [];
  for (const f of findings) {
    const move = f.ruleId === "missing-moved-block" ? ctx.moves?.get(f.resource) : undefined;
    // A module-level move has movedFrom set to the module address rather than the resource's own address.
    if (!move || move.movedFrom === f.resource) rest.push(f);
    else groups.set(move.movedFrom, [...(groups.get(move.movedFrom) ?? []), f]);
  }

  for (const [from, group] of groups) {
    const to = ctx.moves!.get(group[0]!.resource)!.movedTo;
    const ordered = [...group].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
    const names = ordered.map((f) => f.resource.slice(from.length + 1));
    const listed = names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ");
    const withData = ordered.filter((f) => f.category === "data-loss").map((f) => f.resource.slice(from.length + 1));
    rest.push({
      resource: from,
      severity: ordered[0]!.severity,
      category: withData.length ? "data-loss" : "destroy",
      issue: `${from} was renamed to ${to} without a \`moved\` block, so Terraform destroys all ${group.length} resources in it and creates empty copies: ${listed}.`,
      blastRadius: withData.length
        ? `Data in ${withData.join(", ")} is permanently deleted; everything else gets new IDs.`
        : "Downtime while resources are recreated; anything referencing them gets new IDs.",
      suggestion: ordered[0]!.suggestion,
      source: "precheck",
      ruleId: "missing-moved-block",
      relatedResources: ordered.map((f) => f.resource),
    });
  }
  return rest;
}
