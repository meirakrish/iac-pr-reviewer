import { readFile } from "node:fs/promises";
import { changeKind, type ResourceChange, type TerraformPlan } from "./types.js";
import type { ChangeStats } from "../schema.js";

export class PlanError extends Error {}

export async function loadPlanFile(path: string): Promise<TerraformPlan> {
  const raw = path === "-" ? await readStdin() : await readFile(path, "utf8");
  return parsePlan(raw);
}

export function parsePlan(raw: string): TerraformPlan {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new PlanError(
      `Plan is not valid JSON: ${(err as Error).message}. Did you pass the binary plan instead of \`terraform show -json\` output?`,
    );
  }
  if (!data || typeof data !== "object" || !("format_version" in data)) {
    throw new PlanError(
      "Not a Terraform plan JSON: missing format_version. Generate it with `terraform show -json plan.tfplan`.",
    );
  }
  const plan = data as TerraformPlan;
  if (plan.resource_changes !== undefined && !Array.isArray(plan.resource_changes)) {
    throw new PlanError("Invalid plan JSON: resource_changes is not an array.");
  }
  return plan;
}

/** Managed resources whose planned action is anything other than no-op/read. */
export function changedResources(plan: TerraformPlan): ResourceChange[] {
  return (plan.resource_changes ?? []).filter((rc) => {
    if (rc.mode !== "managed") return false;
    const kind = changeKind(rc.change.actions);
    return kind !== "no-op" && kind !== "read";
  });
}

/** Counts per action for changed resources, plus resources renamed by `moved` blocks (from the full plan). */
export function changeStats(changes: ResourceChange[], all: ResourceChange[] = changes): ChangeStats {
  const stats: ChangeStats = { create: 0, update: 0, delete: 0, replace: 0, moved: 0 };
  stats.moved = all.filter(
    (rc) => rc.mode === "managed" && rc.previous_address && rc.previous_address !== rc.address,
  ).length;
  for (const rc of changes) {
    const kind = changeKind(rc.change.actions);
    if (kind === "create" || kind === "update" || kind === "delete" || kind === "replace") stats[kind]++;
  }
  return stats;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
