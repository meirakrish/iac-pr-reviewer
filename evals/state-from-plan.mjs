#!/usr/bin/env node
/**
 * Build a terraform.tfstate from the plan of a config that creates everything, so eval cases can start from
 * a realistic "before" state instead of hand-written attributes.
 *
 *   node evals/state-from-plan.mjs plan.json [--move NEW=OLD ...] > terraform.tfstate
 *
 * --move relocates resources: e.g. --move module.orders_database=module.orders_db stores everything planned
 * under module.orders_database at module.orders_db, to simulate a module that has since been renamed.
 * Values Terraform only knows after apply get mock values (ids/ARNs) or are left out.
 */
import { readFileSync } from "node:fs";

const [planPath, ...rest] = process.argv.slice(2);
if (!planPath) {
  console.error("usage: state-from-plan.mjs plan.json [--move NEW=OLD ...]");
  process.exit(1);
}
const moves = [];
for (let i = 0; i < rest.length; i++) if (rest[i] === "--move") moves.push(rest[++i].split("="));

const plan = JSON.parse(readFileSync(planPath, "utf8"));
const unknownByAddress = new Map(plan.resource_changes.map((rc) => [rc.address, rc.change.after_unknown ?? {}]));

const relocate = (addr) => {
  for (const [from, to] of moves) if (addr === from || addr.startsWith(from + ".")) return to + addr.slice(from.length);
  return addr;
};

let n = 0;
/** Fill computed attributes Terraform reported as unknown with plausible mock values. */
function fill(values, unknown, shapes, type) {
  const out = { ...values };
  for (const [k, u] of Object.entries(unknown)) {
    if (u !== true) continue;
    if (k === "id" || k.endsWith("_id")) out[k] = `${type}-mock-${++n}`;
    else if (k === "arn") out[k] = `arn:aws:mock:us-east-1:123456789012:${type}/${++n}`;
    else if (k === "tags_all") out[k] = values.tags ?? {};
    else if (k === "terraform_labels" || k === "effective_labels") out[k] = values.labels ?? {};
    // sensitive_values mirrors the shape of list/map attributes; an empty one is a stable "after apply" value.
    else if (Array.isArray(shapes[k])) out[k] = [];
    else if (shapes[k] && typeof shapes[k] === "object") out[k] = {};
  }
  return out;
}

/** State marks sensitive values as attribute paths; derive them from the plan's sensitive_values shape. */
function sensitivePaths(shape, path = []) {
  if (shape === true) return [path];
  if (Array.isArray(shape)) return shape.flatMap((v, i) => sensitivePaths(v, [...path, { type: "index", value: { value: i, type: "number" } }]));
  if (shape && typeof shape === "object") return Object.entries(shape).flatMap(([k, v]) => sensitivePaths(v, [...path, { type: "get_attr", value: k }]));
  return [];
}

const resources = new Map();
function walk(mod) {
  for (const r of mod.resources ?? []) {
    if (r.mode !== "managed") continue;
    const moduleAddr = relocate(mod.address ?? "") || undefined;
    const key = `${moduleAddr ?? ""}|${r.type}|${r.name}`;
    if (!resources.has(key)) {
      resources.set(key, {
        ...(moduleAddr ? { module: moduleAddr } : {}),
        mode: "managed",
        type: r.type,
        name: r.name,
        provider: `provider["${r.provider_name}"]`,
        instances: [],
      });
    }
    resources.get(key).instances.push({
      ...(r.index !== undefined ? { index_key: r.index } : {}),
      schema_version: r.schema_version ?? 0,
      attributes: fill(r.values, unknownByAddress.get(r.address) ?? {}, r.sensitive_values ?? {}, r.type),
      sensitive_attributes: sensitivePaths(r.sensitive_values ?? {}),
    });
  }
  for (const child of mod.child_modules ?? []) walk(child);
}
walk(plan.planned_values.root_module);

process.stdout.write(
  JSON.stringify(
    { version: 4, terraform_version: plan.terraform_version, serial: 1, lineage: "6a0c4d1e-eval-from-plan-000000000000", outputs: {}, resources: [...resources.values()] },
    null,
    1,
  ) + "\n",
);
