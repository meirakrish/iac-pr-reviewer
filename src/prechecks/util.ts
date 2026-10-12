import type { Finding } from "../schema.js";
import { changeKind, type ResourceChange } from "../plan/types.js";
import type { DetectedMove } from "../plan/moves.js";

export interface PrecheckContext {
  requiredTags: string[];
  /** Deleted address → where it seems to have moved (renames without a `moved` block). */
  moves?: Map<string, DetectedMove>;
}

export type Precheck = (rc: ResourceChange, ctx: PrecheckContext) => Finding[];

export function finding(
  rc: ResourceChange,
  ruleId: string,
  f: Omit<Finding, "resource" | "source" | "ruleId">,
): Finding {
  return { resource: rc.address, source: "precheck", ruleId, ...f };
}

/** The planned post-apply attributes, or null when the resource is being destroyed. */
export function after(rc: ResourceChange): Record<string, unknown> | null {
  const kind = changeKind(rc.change.actions);
  if (kind === "delete" || kind === "forget") return null;
  const a = rc.change.after;
  return a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : null;
}

export function asArray<T = unknown>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  return v === undefined || v === null ? [] : [v as T];
}

export interface PolicyStatement {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Principal?: unknown;
  Condition?: unknown;
}

/**
 * Parse an IAM-style policy document given as a JSON string, as it appears in plans.
 * Returns [] when the policy is unknown or unparseable.
 */
export function parsePolicy(doc: unknown): PolicyStatement[] {
  if (typeof doc !== "string" || doc.trim() === "") return [];
  try {
    const parsed = JSON.parse(doc) as { Statement?: unknown };
    return asArray<PolicyStatement>(parsed.Statement).filter((s) => s && typeof s === "object");
  } catch {
    return [];
  }
}

/** True when a Principal grants access to everyone: "*" or {"AWS": "*"}. */
export function isPublicPrincipal(principal: unknown): boolean {
  if (principal === "*") return true;
  if (principal && typeof principal === "object") {
    return Object.values(principal as Record<string, unknown>).some((v) => asArray(v).includes("*"));
  }
  return false;
}
