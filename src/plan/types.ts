// Subset of the `terraform show -json` plan format that we rely on.
// https://developer.hashicorp.com/terraform/internals/json-format

export type Action = "no-op" | "create" | "read" | "update" | "delete" | "forget";

export interface ResourceChange {
  address: string;
  /** Set when the resource was renamed: by a `moved` block, or implicitly (e.g. adding `count`). */
  previous_address?: string;
  module_address?: string;
  mode: "managed" | "data";
  type: string;
  name: string;
  index?: string | number;
  provider_name?: string;
  change: {
    actions: Action[];
    before: unknown;
    after: unknown;
    after_unknown?: unknown;
    before_sensitive?: unknown;
    after_sensitive?: unknown;
    replace_paths?: unknown[];
  };
  action_reason?: string;
}

export interface TerraformPlan {
  format_version: string;
  terraform_version?: string;
  resource_changes?: ResourceChange[];
  [key: string]: unknown;
}

export type ChangeKind = "create" | "update" | "delete" | "replace" | "read" | "no-op" | "forget";

export function changeKind(actions: Action[]): ChangeKind {
  if (actions.includes("delete") && actions.includes("create")) return "replace";
  if (actions.length === 1) return actions[0] as ChangeKind;
  return "update";
}
