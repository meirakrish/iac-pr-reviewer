import { isDeepStrictEqual } from "node:util";
import { changeKind, type ChangeKind, type ResourceChange } from "./types.js";

export const SENSITIVE = "(sensitive)";
export const UNKNOWN = "(known after apply)";

export interface TrimmedChange {
  address: string;
  /** The resource was renamed from this address via a `moved` block: same real-world object. */
  movedFrom?: string;
  type: string;
  action: ChangeKind;
  actionReason?: string;
  replacePaths?: unknown[];
  /** create: full `after`; delete: full `before`; update/replace: only attributes that differ. */
  values?: Record<string, unknown>;
  changed?: Record<string, { before: unknown; after: unknown }>;
}

export interface TrimmedPlan {
  changes: TrimmedChange[];
  /** Addresses left out because the character budget ran out. */
  omitted: string[];
}

/** Replace every value whose mask is `true` with a placeholder, mirroring Terraform's *_sensitive / after_unknown shapes. */
export function applyMask(value: unknown, mask: unknown, placeholder: string): unknown {
  if (mask === true) return placeholder;
  if (Array.isArray(mask)) {
    if (!Array.isArray(value)) return value;
    return value.map((v, i) => applyMask(v, mask[i], placeholder));
  }
  if (mask && typeof mask === "object") {
    const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
    if (!isObject && (value != null || placeholder !== UNKNOWN)) return value;
    const out: Record<string, unknown> = isObject ? { ...(value as Record<string, unknown>) } : {};
    for (const [k, m] of Object.entries(mask as Record<string, unknown>)) {
      // Terraform omits unknown attributes from `after`, so materialise them from the mask.
      if (k in out || (m === true && placeholder === UNKNOWN)) out[k] = applyMask(out[k], m, placeholder);
    }
    return out;
  }
  return value;
}

export function sanitizedBefore(rc: ResourceChange): unknown {
  return applyMask(rc.change.before, rc.change.before_sensitive, SENSITIVE);
}

export function sanitizedAfter(rc: ResourceChange): unknown {
  const withUnknown = applyMask(rc.change.after, rc.change.after_unknown, UNKNOWN);
  return applyMask(withUnknown, rc.change.after_sensitive, SENSITIVE);
}

const ACTION_PRIORITY: Record<string, number> = { delete: 0, replace: 1, forget: 2, create: 3, update: 4 };

export function trimChange(rc: ResourceChange): TrimmedChange {
  const action = changeKind(rc.change.actions);
  const out: TrimmedChange = { address: rc.address, type: rc.type, action };
  if (rc.previous_address) out.movedFrom = rc.previous_address;
  if (rc.action_reason) out.actionReason = rc.action_reason;
  if (rc.change.replace_paths?.length) out.replacePaths = rc.change.replace_paths;

  const before = asRecord(sanitizedBefore(rc));
  const after = asRecord(sanitizedAfter(rc));

  if (action === "create") out.values = dropEmpty(after);
  else if (action === "delete" || action === "forget") out.values = dropEmpty(before);
  else {
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!isDeepStrictEqual(before[key], after[key])) changed[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
    out.changed = changed;
  }
  return out;
}

/** Sanitize and shrink changed resources so the plan fits in an LLM prompt. Riskiest actions are kept first. */
export function trimPlan(changes: ResourceChange[], maxChars = 40_000): TrimmedPlan {
  const sorted = [...changes].sort(
    (a, b) => (ACTION_PRIORITY[changeKind(a.change.actions)] ?? 9) - (ACTION_PRIORITY[changeKind(b.change.actions)] ?? 9),
  );
  const result: TrimmedPlan = { changes: [], omitted: [] };
  let used = 0;
  for (const rc of sorted) {
    const trimmed = trimChange(rc);
    const size = JSON.stringify(trimmed).length;
    if (used + size > maxChars) {
      result.omitted.push(rc.address);
      continue;
    }
    used += size;
    result.changes.push(trimmed);
  }
  return result;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Drop null / empty-collection attributes — they are mostly provider defaults and waste tokens. */
function dropEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}
