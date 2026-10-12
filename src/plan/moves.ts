import { changeKind, type ResourceChange } from "./types.js";

export interface DetectedMove {
  from: string;
  to: string;
  /** "module": same resource inside a renamed module; "identity": same type and same name/identifier attribute. */
  via: "module" | "identity";
  /** The `moved` block that fixes it: the whole module when every resource moved together, else this resource. */
  movedFrom: string;
  movedTo: string;
}

/** Attributes that identify the real-world object; a delete+create sharing one of these is almost certainly a rename. */
const IDENTITY_ATTRS = [
  "bucket",
  "identifier",
  "cluster_identifier",
  "function_name",
  "table_name",
  "repository_name",
  "domain_name",
  "name",
];

function modulePath(rc: ResourceChange): string {
  return rc.module_address ?? "";
}

/** Address relative to its module, e.g. `aws_db_instance.this` for `module.db.aws_db_instance.this`. */
function relativeAddress(rc: ResourceChange): string {
  const mod = modulePath(rc);
  return mod ? rc.address.slice(mod.length + 1) : rc.address;
}

function identity(rc: ResourceChange, values: unknown): string | null {
  if (!values || typeof values !== "object") return null;
  const v = values as Record<string, unknown>;
  for (const attr of IDENTITY_ATTRS) {
    if (typeof v[attr] === "string" && v[attr] !== "") return `${rc.type}|${attr}|${v[attr]}`;
  }
  return null;
}

/**
 * Find resources that are destroyed at one address and created at another: renames or module refactors
 * done without a `moved` block. Expects every resource change in the plan (including no-ops), so it can
 * tell whether a whole module moved.
 */
export function detectMoves(all: ResourceChange[]): Map<string, DetectedMove> {
  const managed = all.filter((rc) => rc.mode === "managed");
  const deleted = managed.filter((rc) => changeKind(rc.change.actions) === "delete");
  const created = managed.filter((rc) => changeKind(rc.change.actions) === "create");
  const used = new Set<ResourceChange>();
  const pairs: { d: ResourceChange; c: ResourceChange; via: DetectedMove["via"] }[] = [];

  // 1. Same resource address inside a different module (module renamed or re-nested).
  for (const d of deleted) {
    const c = created.find(
      (c) => !used.has(c) && c.type === d.type && relativeAddress(c) === relativeAddress(d) && modulePath(c) !== modulePath(d),
    );
    if (c) {
      used.add(c);
      pairs.push({ d, c, via: "module" });
    }
  }

  // 2. Same type and same identifying attribute value (resource renamed, possibly also moved between modules).
  for (const d of deleted) {
    if (pairs.some((p) => p.d === d)) continue;
    const id = identity(d, d.change.before);
    if (!id) continue;
    const c = created.find((c) => !used.has(c) && identity(c, c.change.after) === id);
    if (c) {
      used.add(c);
      pairs.push({ d, c, via: "identity" });
    }
  }

  // A whole module moved if every resource still in the old module path is being deleted and paired
  // via "module" to the same new path. Then one module-level `moved` block covers all of them.
  const moduleTarget = new Map<string, string | null>();
  for (const { d, c, via } of pairs) {
    const from = modulePath(d);
    if (!from) continue;
    const to = via === "module" ? modulePath(c) : null;
    moduleTarget.set(from, moduleTarget.has(from) && moduleTarget.get(from) !== to ? null : to);
  }
  for (const rc of managed) {
    const from = modulePath(rc);
    if (moduleTarget.has(from) && !pairs.some((p) => p.d === rc)) moduleTarget.set(from, null);
  }

  const moves = new Map<string, DetectedMove>();
  for (const { d, c, via } of pairs) {
    const wholeModule = via === "module" ? moduleTarget.get(modulePath(d)) : null;
    moves.set(d.address, {
      from: d.address,
      to: c.address,
      via,
      movedFrom: wholeModule ? modulePath(d) : d.address,
      movedTo: wholeModule ?? c.address,
    });
  }
  return moves;
}
