import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlan } from "../src/plan/load.js";
import type { Action, ResourceChange, TerraformPlan } from "../src/plan/types.js";

export function evalPlan(name: string): TerraformPlan {
  return parsePlan(readFileSync(join(import.meta.dirname, "..", "evals", "cases", name, "plan.json"), "utf8"));
}

export function rc(
  type: string,
  after: Record<string, unknown> | null,
  actions: Action[] = ["create"],
  extra: Partial<ResourceChange["change"]> = {},
): ResourceChange {
  return {
    address: `${type}.test`,
    mode: "managed",
    type,
    name: "test",
    change: { actions, before: null, after, ...extra },
  };
}
